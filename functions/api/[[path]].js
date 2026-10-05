// Secret Collection BD — server functions for Cloudflare Pages
// One file handles every /api/... address:
//   POST /api/order      create an order (prices checked against products.json, spam limits, email alert)
//   POST /api/claim      add a guest order to the signed-in customer's account (Order ID + phone)
//   POST /api/steadfast  admin only: balance / create parcel / parcel status
//   POST /api/sfhook     Steadfast webhook: courier status changes arrive here instantly
//   *    /api/notify     retired (410)
//
// Cloudflare → Workers & Pages → your project → Settings → Variables and Secrets (type: Secret):
//   FIREBASE_SERVICE_ACCOUNT  whole JSON file from Firebase → Project settings → Service accounts → Generate new private key
//     (or instead two secrets: FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, copied from that file)
//   RESEND_API_KEY            order email alerts
//   STEADFAST_API_KEY / STEADFAST_SECRET_KEY   delivery partner
//   STEADFAST_WEBHOOK_TOKEN   any long random text; the same text goes into Steadfast → Webhook → Auth token
// Optional: NOTIFY_EMAIL, NOTIFY_FROM, FIREBASE_DATABASE_URL, FIREBASE_WEB_API_KEY, STEADFAST_BASE_URL
// No packages needed.

const ADMIN_EMAILS = ['md.moinuddin.hridoy@gmail.com'];
const DEFAULTS = {
  DB_URL: 'https://secret-collection-bd-default-rtdb.asia-southeast1.firebasedatabase.app',
  WEB_KEY: 'AIzaSyB_xMPnzuNieOtMZWE3ozmdBa0jxGKHkO4',
  NOTIFY_TO: 'md.moinuddin.hridoy@gmail.com',
  NOTIFY_FROM: 'Secret Collection BD <onboarding@resend.dev>',
  STEADFAST: 'https://portal.packzy.com/api/v1'
};
const cfg = (env) => ({
  db: (env.FIREBASE_DATABASE_URL || DEFAULTS.DB_URL).replace(/\/+$/, ''),
  webKey: env.FIREBASE_WEB_API_KEY || DEFAULTS.WEB_KEY,
  to: env.NOTIFY_EMAIL || DEFAULTS.NOTIFY_TO,
  from: env.NOTIFY_FROM || DEFAULTS.NOTIFY_FROM,
  sf: (env.STEADFAST_BASE_URL || DEFAULTS.STEADFAST).replace(/\/+$/, ''),
  // service endpoints (overridable only for local testing)
  oauth: env.TEST_OAUTH_URL || 'https://oauth2.googleapis.com/token',
  idtk: env.TEST_IDTK_URL || 'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
  resend: env.TEST_RESEND_URL || 'https://api.resend.com/emails'
});

/* ---------- small helpers ---------- */
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
async function call(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const raw = await r.text(); let j = null; try { j = JSON.parse(raw); } catch (e) {}
    return { ok: r.ok, status: r.status, json: j, raw };
  } finally { clearTimeout(timer); }
}
const enc = new TextEncoder();
const b64url = (bytes) => { let s = ''; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); };
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const normPhone = (v) => { const d = String(v || '').replace(/\D/g, '').replace(/^88(?=01)/, ''); return /^01[3-9]\d{8}$/.test(d) ? d : ''; };
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
class SetupError extends Error { constructor(m) { super(m); this.setup = true; } }

/* ---------- Firebase admin access (service account → OAuth token → Realtime Database REST) ---------- */
let tokenCache = { token: null, exp: 0 };
let keyCache = { pem: null, key: null };
// Accepts the service-account key in any common copy/paste form:
//   the whole JSON file (with or without line breaks), wrapped in quotes, double-encoded, base64,
//   or two separate secrets FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.
function escapeNewlinesInStrings(t) {
  let out = '', inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out;
}
function parseServiceAccount(raw) {
  let s = String(raw || '').replace(/^﻿/, '').trim();
  const orig = s;
  if (s.length > 1 && /^['"`]/.test(s) && s[0] === s[s.length - 1] && s[1] === '{') s = s.slice(1, -1).trim();   // 'wrapped in quotes'
  const smart = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const tries = [s, escapeNewlinesInStrings(s), smart, escapeNewlinesInStrings(smart), orig, escapeNewlinesInStrings(orig)];
  if (!s.startsWith('{') && /"client_email"/.test(s)) tries.push('{' + escapeNewlinesInStrings(smart).replace(/,\s*$/, '') + '}');   // braces missing
  if (/^[A-Za-z0-9+/=\s_-]+$/.test(s) && s.length > 100) { try { tries.push(atob(s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) {} }   // base64
  for (const t of tries) {
    try {
      let v = JSON.parse(t);
      if (typeof v === 'string') v = JSON.parse(escapeNewlinesInStrings(v));   // double-encoded
      if (v && v.client_email && v.private_key) return v;
    } catch (e) {}
  }
  return null;
}
function serviceAccount(env) {
  let sa = null;
  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) sa = { client_email: String(env.FIREBASE_CLIENT_EMAIL).trim().replace(/^["']|["']$/g, ''), private_key: String(env.FIREBASE_PRIVATE_KEY).trim().replace(/^["']|["']$/g, '') };
  else if (env.FIREBASE_SERVICE_ACCOUNT) {
    sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
    if (!sa) {
      const s = String(env.FIREBASE_SERVICE_ACCOUNT).trim();
      throw new SetupError(`FIREBASE_SERVICE_ACCOUNT could not be read (it has ${s.length} characters, starts with "${s.slice(0, 1)}" and ends with "${s.slice(-1)}"; a complete key file has about 2,300 characters and starts with { and ends with }). Copy it again from the downloaded .json file, or use FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY instead.`);
    }
  } else throw new SetupError('Server is not connected to the database yet (FIREBASE_SERVICE_ACCOUNT missing in Cloudflare).');
  sa.private_key = String(sa.private_key).replace(/\\n/g, '\n').replace(/\r/g, '');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(sa.private_key)) throw new SetupError('The Firebase private key is incomplete: it must start with -----BEGIN PRIVATE KEY-----.');
  return sa;
}
async function signingKey(pem) {
  if (keyCache.pem === pem) return keyCache.key;
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64), der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { pem, key };
  return key;
}
async function accessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const sa = serviceAccount(env), now = Math.floor(Date.now() / 1000), C = cfg(env);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
  let sig;
  try { sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(sa.private_key), enc.encode(`${head}.${claim}`))); }
  catch (e) { throw new SetupError('The FIREBASE_SERVICE_ACCOUNT private key could not be read. Paste the whole downloaded file again.'); }
  const r = await call(C.oauth, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}` });
  if (!r.ok || !r.json || !r.json.access_token) throw new SetupError('Database login failed: ' + ((r.json && (r.json.error_description || r.json.error)) || r.status));
  tokenCache = { token: r.json.access_token, exp: Date.now() + (r.json.expires_in || 3600) * 1000 };
  return tokenCache.token;
}
async function db(env, method, path, body, query = '') {
  const t = await accessToken(env);
  const r = await call(`${cfg(env).db}/${path.replace(/^\/+/, '')}.json?access_token=${encodeURIComponent(t)}${query}`,
    { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Database ${method} ${path} failed (${r.status}): ${(r.json && r.json.error) || r.raw.slice(0, 120)}`);
  return r.json;
}
const dbGet = (env, path, q) => db(env, 'GET', path, undefined, q);
const dbPatch = (env, path, body) => db(env, 'PATCH', path, body);
const dbPut = (env, path, body) => db(env, 'PUT', path, body);

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
function pushKey() {
  let now = Date.now(), t = '';
  for (let i = 0; i < 8; i++) { t = PUSH_CHARS.charAt(now % 64) + t; now = Math.floor(now / 64); }
  const rnd = randomBytes(12);
  for (let i = 0; i < 12; i++) t += PUSH_CHARS.charAt(rnd[i] % 64);
  return t;
}

/* ---------- login checks (Firebase ID token) ---------- */
async function verifyUser(env, idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 5000) return null;
  const C = cfg(env);
  const r = await call(`${C.idtk}?key=${C.webKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }, 8000);
  const u = r.ok && r.json && r.json.users && r.json.users[0];
  return u ? { uid: u.localId, email: String(u.email || '').toLowerCase(), emailVerified: !!u.emailVerified } : null;
}

/* ---------- rate limit stored in the database ---------- */
async function rateLimit(env, bucket, key, limit, windowMs) {
  const path = `rate/${bucket}/${(await sha256hex('scbd-rate:' + key)).slice(0, 24)}`, now = Date.now();
  const cur = (await dbGet(env, path)) || {};
  const hits = (Array.isArray(cur.hits) ? cur.hits : []).filter(t => now - t < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  await dbPut(env, path, { hits, updated: now });
  return true;
}

/* ---------- order email (Resend) ---------- */
async function sendOrderEmail(env, o) {
  if (!env.RESEND_API_KEY) return false;
  const C = cfg(env);
  const taka = (n) => '৳' + Number(n).toLocaleString('en-IN');
  const items = o.items.map((l, n) => `${n + 1}. ${l.name} (${l.id})\n   Size: ${l.size} | Color: ${l.color}\n   ${l.qty} × ${taka(l.price)} = ${taka(l.lineTotal)}`).join('\n\n');
  const text = `NEW ORDER — SECRET COLLECTION BD
Order No: ${o.orderNo}
━━━━━━━━━━━━━━━

ORDER ITEMS
${items}

━━━━━━━━━━━━━━━
Subtotal: ${taka(o.subtotal)}
Delivery: FREE
TOTAL: ${taka(o.total)} BDT

CUSTOMER
Name: ${o.customer.name}
Phone: ${o.customer.phone}${o.customer.email ? `\nEmail: ${o.customer.email}` : ''}
Address: ${o.customer.address}${o.uid ? '\nAccount: signed-in customer' : ''}

PAYMENT
Method: ${o.payment.method}
TrxID / Ref: ${o.payment.trx}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e5e5">
  <div style="background:#0F0F0F;color:#fff;padding:18px 22px;font-size:16px;letter-spacing:2px">NEW ORDER — SECRET COLLECTION BD</div>
  <div style="padding:22px;font-size:14px;line-height:1.6;color:#222">${esc(text).replace(/^(NEW ORDER.*|ORDER ITEMS|CUSTOMER|PAYMENT|TOTAL:.*|Order No:.*)$/gm, '<b>$1</b>').replace(/━+/g, '<hr style="border:0;border-top:1px solid #eee">').replace(/\n/g, '<br>')}
  <p style="margin-top:18px"><a href="tel:+88${esc(o.customer.phone)}" style="background:#0F0F0F;color:#fff;padding:10px 16px;text-decoration:none;font-size:12px;letter-spacing:1px">CALL CUSTOMER</a></p></div></div>`;
  try {
    const r = await call(C.resend, { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: C.from, to: [C.to], subject: `New order ${o.orderNo} — ${taka(o.total)} — ${o.customer.name}`.slice(0, 180), text, html,
        ...(o.customer.email ? { reply_to: o.customer.email } : {}) }) }, 8000);
    if (!r.ok) console.error('Order email failed', r.status, r.raw.slice(0, 200));
    return r.ok;
  } catch (e) { console.error('Order email error', e); return false; }
}

/* ======================= POST /api/order ======================= */
let productCache = { at: 0, list: null };
async function loadProducts(ctx) {
  if (productCache.list && Date.now() - productCache.at < 60000) return productCache.list;
  const url = new URL('/products.json?v=' + Date.now(), ctx.request.url);
  const r = ctx.env.ASSETS ? await ctx.env.ASSETS.fetch(new Request(url)) : await fetch(url);
  let list = null; try { list = await r.json(); } catch (e) {}
  if (!r.ok || !Array.isArray(list)) throw new Error('Could not load the product list');
  productCache = { at: Date.now(), list };
  return list;
}
function makeOrderNo() {
  const d = new Date(Date.now() + 6 * 3600e3);   // Bangladesh date
  const p = (n) => String(n).padStart(2, '0');
  const r = [...randomBytes(4)].map(b => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[b % 36]).join('');
  return `SCB-${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${r}`;
}
async function handleOrder(ctx, b) {
  const env = ctx.env;
  const fail = (status, error) => json(status, { error });
  // 1. bot checks: hidden trap field must be empty, form can't be filled in under 3 seconds
  if (b.hp) return fail(400, 'Could not place the order.');
  if (!(Number(b.ms) >= 3000)) return fail(400, 'Please take a moment to check your details, then tap Confirm again.');
  // 2. customer & payment
  const c = b.customer || {}, pay = b.payment || {};
  const customer = { name: clip(c.name, 80), phone: normPhone(c.phone), email: clip(c.email, 100).toLowerCase(), address: clip(c.address, 300) };
  if (customer.name.length < 2) return fail(400, 'Please enter your name.');
  if (!customer.phone) return fail(400, 'Please enter a valid Bangladeshi phone number (01XXXXXXXXX).');
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customer.email)) return fail(400, 'Please enter a valid email, or leave it empty.');
  if (customer.address.length < 8) return fail(400, 'Please enter your full delivery address.');
  const method = ['bKash', 'Nagad'].includes(pay.method) ? pay.method : '';
  const trx = clip(pay.trx, 40).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!method) return fail(400, 'Please choose bKash or Nagad.');
  if (trx.length < 4) return fail(400, 'Please enter your TrxID / payment reference.');
  // 3. rebuild the cart from the real product list (browser prices are ignored)
  const raw = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
  if (!raw.length) return fail(400, 'Your bag is empty.');
  const products = await loadProducts(ctx);
  const byId = Object.fromEntries(products.map(p => [String(p.id), p]));
  const items = [];
  for (const it of raw) {
    const p = byId[String(it.id)];
    if (!p || p.active === false) return fail(409, `A product in your bag is no longer available (${clip(it.id, 20)}). Please remove it and try again.`);
    const qty = Math.max(1, Math.min(20, parseInt(it.qty, 10) || 1));
    const sizes = Array.isArray(p.sizes) && p.sizes.length ? p.sizes : ['Free Size'];
    const colors = Array.isArray(p.colors) && p.colors.length ? p.colors : ['Default'];
    const size = sizes.includes(it.size) ? it.size : sizes[0];
    const color = colors.includes(it.color) ? it.color : colors[0];
    const price = Math.round(Number(p.price));
    if (!(price > 0)) return fail(409, `Price missing for ${p.id}.`);
    items.push({ id: String(p.id), name: String(p.name), category: String(p.category || ''), size, color, qty, price, lineTotal: price * qty,
      image: String(p.image || (p.images || [])[0] || '') });
  }
  const subtotal = items.reduce((n, l) => n + l.lineTotal, 0), total = subtotal;   // delivery is FREE
  // 4. rate limits (per network and per phone number)
  const ip = ctx.request.headers.get('CF-Connecting-IP') || ctx.request.headers.get('x-forwarded-for') || 'unknown';
  if (!(await rateLimit(env, 'ip', ip, 30, 3600e3))) return fail(429, 'Too many orders from this network. Please try again in an hour or message us.');
  if (!(await rateLimit(env, 'phone', customer.phone, 6, 24 * 3600e3))) return fail(429, 'Too many orders for this phone number today. Please message us to order more.');
  // 5. signed-in customer?
  const user = b.idToken ? await verifyUser(env, b.idToken) : null;
  // 6. save
  let orderNo = makeOrderNo();
  for (let i = 0; i < 3 && (await dbGet(env, 'orderStatus/' + orderNo)); i++) orderNo = makeOrderNo();
  const key = pushKey(), now = Date.now();
  const order = { orderNo, source: 'website', customer, payment: { method, trx }, items, subtotal, delivery: 0, total,
    uid: user ? user.uid : null, status: 'Pending', createdAt: now };
  const status = { status: 'Pending', createdAt: now, total, itemCount: items.reduce((n, l) => n + l.qty, 0) };
  const upd = { [`orders/${key}`]: order, [`orderStatus/${orderNo}`]: status };
  if (user) upd[`userOrders/${user.uid}/${key}`] = order;
  await dbPatch(env, '', upd);
  // 7. email alert to the shop
  const emailed = await sendOrderEmail(env, order);
  return json(200, { ok: true, orderNo, total, subtotal, emailed });
}

/* ======================= POST /api/claim ======================= */
async function handleClaim(ctx, b) {
  const env = ctx.env, fail = (status, error) => json(status, { error });
  const user = await verifyUser(env, b.idToken);
  if (!user) return fail(401, 'Please sign in again.');
  const orderNo = String(b.orderNo || '').trim().toUpperCase();
  const phone = normPhone(b.phone);
  if (!/^SCB-\d{6}-[A-Z0-9]{4}$/.test(orderNo)) return fail(400, 'Please enter your Order ID, e.g. SCB-260929-AB12.');
  if (!phone) return fail(400, 'Please enter the phone number used for the order (01XXXXXXXXX).');
  if (!(await rateLimit(env, 'claim', user.uid, 10, 3600e3))) return fail(429, 'Too many attempts. Please try again in an hour.');
  const found = await dbGet(env, 'orders', `&orderBy=${encodeURIComponent('"orderNo"')}&equalTo=${encodeURIComponent(JSON.stringify(orderNo))}`);
  const entry = found && Object.entries(found)[0];
  // same answer for "not found" and "wrong phone", so order IDs can't be probed
  if (!entry || normPhone(entry[1].customer && entry[1].customer.phone) !== phone) return fail(404, 'No order found with this Order ID and phone number.');
  const [key, order] = entry;
  if (order.uid && order.uid !== user.uid) return fail(409, 'This order is already linked to another account.');
  await dbPatch(env, '', { [`orders/${key}/uid`]: user.uid, [`userOrders/${user.uid}/${key}`]: { ...order, uid: user.uid } });
  return json(200, { ok: true, orderNo });
}

/* ======================= POST /api/steadfast (admin) ======================= */
async function handleSteadfast(ctx, body) {
  const env = ctx.env, C = cfg(env);
  const u = await verifyUser(env, body.idToken);
  if (!u || !ADMIN_EMAILS.includes(u.email)) return json(401, { error: 'Admin login required. Please sign in again.' });
  if (!env.STEADFAST_API_KEY || !env.STEADFAST_SECRET_KEY)
    return json(503, { error: 'Steadfast is not connected yet: add STEADFAST_API_KEY and STEADFAST_SECRET_KEY in Cloudflare, then redeploy.' });
  const sf = (path, opts = {}) => call(C.sf + path, { ...opts,
    headers: { 'Api-Key': env.STEADFAST_API_KEY, 'Secret-Key': env.STEADFAST_SECRET_KEY, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } }, 15000);
  const sfError = (r) => {
    const j = (r && r.json) || {};
    if (j.errors && typeof j.errors === 'object') return Object.entries(j.errors).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join(' · ');
    return j.message || j.error || ((r && r.raw) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || `Steadfast error ${r && r.status}`;
  };
  try {
    if (body.action === 'balance') {
      const r = await sf('/get_balance');
      if (!r.ok || !r.json || (r.json.status && Number(r.json.status) !== 200)) return json(502, { error: sfError(r) });
      return json(200, { balance: r.json.current_balance });
    }
    if (body.action === 'status') {
      const tries = [];
      const cid = String(body.consignmentId || '').replace(/\D/g, '');
      const code = String(body.trackingCode || '').replace(/[^A-Za-z0-9]/g, '');
      const inv = String(body.invoice || '').replace(/[^A-Za-z0-9_-]/g, '');
      if (cid) tries.push('/status_by_cid/' + cid);
      if (code) tries.push('/status_by_trackingcode/' + code);
      if (inv) tries.push('/status_by_invoice/' + inv);
      if (!tries.length) return json(400, { error: 'Missing consignment ID / tracking code' });
      let last;
      for (const path of tries) {
        last = await sf(path);
        if (last.ok && last.json && last.json.delivery_status && (!last.json.status || Number(last.json.status) === 200))
          return json(200, { delivery_status: last.json.delivery_status });
      }
      return json(502, { error: sfError(last) });
    }
    if (body.action === 'create') {
      const p = body.parcel || {};
      const phone = String(p.recipient_phone || '').replace(/\D/g, '').replace(/^88(?=01)/, '');
      const parcel = {
        invoice: String(p.invoice || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60),
        recipient_name: String(p.recipient_name || '').trim().slice(0, 100),
        recipient_phone: phone,
        recipient_address: String(p.recipient_address || '').replace(/\s+/g, ' ').trim().slice(0, 250),
        cod_amount: Math.max(0, Math.round(Number(p.cod_amount) || 0)),
        note: String(p.note || '').trim().slice(0, 500)
      };
      if (p.item_description) parcel.item_description = String(p.item_description).slice(0, 500);
      if (p.total_lot) parcel.total_lot = Math.max(1, parseInt(p.total_lot, 10) || 1);
      if (p.recipient_email && /^\S+@\S+\.\S+$/.test(p.recipient_email)) parcel.recipient_email = String(p.recipient_email).slice(0, 100);
      if (!parcel.invoice) return json(400, { error: 'Missing invoice (order number)' });
      if (!parcel.recipient_name) return json(400, { error: 'Missing customer name' });
      if (!/^01[3-9]\d{8}$/.test(phone)) return json(400, { error: 'Customer phone must be 11 digits (01XXXXXXXXX)' });
      if (parcel.recipient_address.length < 5) return json(400, { error: 'Missing delivery address' });
      const r = await sf('/create_order', { method: 'POST', body: JSON.stringify(parcel) });
      const c = r.json && r.json.consignment;
      if (!r.ok || !c || (r.json.status && Number(r.json.status) !== 200)) return json(502, { error: sfError(r) });
      return json(200, { consignment: c, message: r.json.message });
    }
    return json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('Steadfast error:', err);
    return json(502, { error: err.name === 'AbortError' ? 'Steadfast did not respond in time. Please try again.' : 'Could not reach Steadfast. Please try again.' });
  }
}

/* ======================= POST /api/sfhook (Steadfast webhook) ======================= */
// Steadfast calls this when a parcel's status changes. The order, the customer's copy and the
// public tracking card are updated right away (the admin dashboard shows it live).
// Statuses not listed here (e.g. "unknown") are saved but do NOT change the order status: the admin sets it by hand.
const SF_TO_ORDER = { in_review: 'Confirmed', pending: 'Shipped', hold: 'Shipped', delivered: 'Delivered', partial_delivered: 'Delivered', cancelled: 'Cancelled',
  delivered_approval_pending: 'Delivered', partial_delivered_approval_pending: 'Delivered', cancelled_approval_pending: 'Cancelled' };
async function sameSecret(a, b) { return (await sha256hex('scbd:' + a)) === (await sha256hex('scbd:' + b)); }
async function handleSfHook(ctx, b) {
  const env = ctx.env, req = ctx.request;
  if (!env.STEADFAST_WEBHOOK_TOKEN) return json(503, { status: 'error', message: 'Webhook token not set (STEADFAST_WEBHOOK_TOKEN)' });
  const auth = req.headers.get('Authorization') || '';
  const given = (auth.match(/^Bearer\s+(.+)$/i) || [])[1] || req.headers.get('X-Webhook-Token') || req.headers.get('Api-Key') || new URL(req.url).searchParams.get('token') || '';
  if (!given || !(await sameSecret(given.trim(), String(env.STEADFAST_WEBHOOK_TOKEN).trim()))) return json(401, { status: 'error', message: 'Unauthorized' });

  const type = clip(b.notification_type, 40).toLowerCase();
  const invoice = clip(b.invoice, 60).replace(/[^A-Za-z0-9_-]/g, '');
  const cid = String(b.consignment_id || '').replace(/\D/g, '');
  const sfStatus = clip(b.status || b.delivery_status, 60).toLowerCase().replace(/\s+/g, '_');
  const message = clip(b.tracking_message, 250);
  const ack = (extra) => json(200, { status: 'success', message: 'Webhook received', ...extra });
  if (!invoice) return ack({ matched: false });

  const found = await dbGet(env, 'orders', `&orderBy=${encodeURIComponent('"orderNo"')}&equalTo=${encodeURIComponent(JSON.stringify(invoice))}`) || {};
  const key = Object.keys(found)[0];
  if (!key) return ack({ matched: false });
  const o = found[key];
  if (!o.delivery) return ack({ matched: true, linked: false });                 // not sent from the admin panel → link it there first
  if (cid && o.delivery.consignmentId && String(o.delivery.consignmentId) !== cid) return ack({ matched: true, linked: false });

  const now = Date.now();
  const delivery = { ...o.delivery, checkedAt: now };
  if (sfStatus && type !== 'tracking_update') delivery.status = sfStatus;
  if (message) delivery.message = message;
  const status = SF_TO_ORDER[delivery.status] || o.status;                    // unknown → keep what the admin set
  const changed = status !== o.status;
  const upd = { [`orders/${key}/delivery`]: delivery };
  if (changed) { upd[`orders/${key}/status`] = status; upd[`orders/${key}/updatedAt`] = now; }
  if (o.uid) {
    upd[`userOrders/${o.uid}/${key}/delivery`] = delivery;
    if (changed) { upd[`userOrders/${o.uid}/${key}/status`] = status; upd[`userOrders/${o.uid}/${key}/updatedAt`] = now; }
  }
  const pub = delivery.trackingCode ? { partner: delivery.partner || 'Steadfast', trackingCode: delivery.trackingCode, status: delivery.status || null, sentAt: delivery.sentAt || null } : null;
  upd[`orderStatus/${o.orderNo}`] = JSON.parse(JSON.stringify({ status, createdAt: o.createdAt, updatedAt: changed ? now : (o.updatedAt || null), total: o.total,
    itemCount: (o.items || []).reduce((n, i) => n + (Number(i.qty) || 1), 0), delivery: pub }));
  await dbPatch(env, '', upd);
  return ack({ matched: true, orderStatus: status, changed });
}

/* ======================= router ======================= */
export async function onRequest(ctx) {
  const name = String([].concat(ctx.params.path || []).join('/')).toLowerCase();
  if (name === 'notify') return json(410, { error: 'Moved to /api/order' });
  const handler = { order: handleOrder, claim: handleClaim, steadfast: handleSteadfast, sfhook: handleSfHook }[name];
  if (!handler) return json(404, { error: 'Not found' });
  if (name === 'sfhook' && ctx.request.method !== 'POST') return json(200, { status: 'success', message: 'Webhook endpoint is ready' });   // URL check
  if (ctx.request.method !== 'POST') return json(405, { error: 'POST only' });
  let body = {};
  try { body = await ctx.request.json(); } catch (e) { body = {}; }
  if (!body || typeof body !== 'object') body = {};
  try {
    return await handler(ctx, body);
  } catch (err) {
    console.error(`/api/${name} error:`, err);
    if (err.setup) return json(503, { error: err.message });
    if (name === 'sfhook') return json(500, { status: 'error', message: 'Could not save the update' });   // Steadfast retries later
    return json(502, { error: name === 'claim' ? 'Could not add the order right now. Please try again.' : 'Could not place the order right now. Please try again.' });
  }
}
