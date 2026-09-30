// Shared helpers for /api/order and /api/claim (files starting with "_" are not public endpoints on Vercel).
// No packages needed.
//
// Vercel → Project → Settings → Environment Variables:
//   FIREBASE_SERVICE_ACCOUNT  the whole JSON file from Firebase → Project settings → Service accounts → Generate new private key
//   RESEND_API_KEY            order email alerts (already set)
//   NOTIFY_EMAIL / NOTIFY_FROM optional (see below)

const crypto = require('crypto');

const DB_URL = (process.env.FIREBASE_DATABASE_URL || 'https://secret-collection-bd-default-rtdb.asia-southeast1.firebasedatabase.app').replace(/\/+$/, '');
const WEB_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyB_xMPnzuNieOtMZWE3ozmdBa0jxGKHkO4';
const NOTIFY_TO = process.env.NOTIFY_EMAIL || 'md.moinuddin.hridoy@gmail.com';
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'Secret Collection BD <onboarding@resend.dev>';

async function call(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch (e) {}
    return { ok: r.ok, status: r.status, json, raw };
  } finally { clearTimeout(timer); }
}

/* ---------- Firebase admin access (service account → OAuth token → Realtime Database REST) ---------- */
let tokenCache = { token: null, exp: 0 };
function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { const e = new Error('Server is not connected to the database yet (FIREBASE_SERVICE_ACCOUNT missing in Vercel).'); e.setup = true; throw e; }
  let sa; try { sa = JSON.parse(raw); } catch (e) { const x = new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole downloaded file.'); x.setup = true; throw x; }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const sa = serviceAccount(), now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key));
  const r = await call('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}` });
  if (!r.ok || !r.json || !r.json.access_token) { const e = new Error('Database login failed: ' + ((r.json && (r.json.error_description || r.json.error)) || r.status)); e.setup = true; throw e; }
  tokenCache = { token: r.json.access_token, exp: Date.now() + (r.json.expires_in || 3600) * 1000 };
  return tokenCache.token;
}
async function db(method, path, body, query = '') {
  const t = await accessToken();
  const r = await call(`${DB_URL}/${path.replace(/^\/+/, '')}.json?access_token=${encodeURIComponent(t)}${query}`,
    { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Database ${method} ${path} failed (${r.status}): ${(r.json && r.json.error) || r.raw.slice(0, 120)}`);
  return r.json;
}
const dbGet = (path, query) => db('GET', path, undefined, query);
const dbPatch = (path, body) => db('PATCH', path, body);
const dbPut = (path, body) => db('PUT', path, body);

// Firebase-style push key: time-sortable, unique
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
function pushKey() {
  let now = Date.now(), t = '';
  for (let i = 0; i < 8; i++) { t = PUSH_CHARS.charAt(now % 64) + t; now = Math.floor(now / 64); }
  const rnd = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) t += PUSH_CHARS.charAt(rnd[i] % 64);
  return t;
}

/* ---------- Customer login check (Firebase ID token) ---------- */
async function verifyUser(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 5000) return null;
  const r = await call(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }, 8000);
  const u = r.ok && r.json && r.json.users && r.json.users[0];
  return u ? { uid: u.localId, email: String(u.email || '').toLowerCase(), emailVerified: !!u.emailVerified } : null;
}

/* ---------- Misc ---------- */
const normPhone = (v) => { const d = String(v || '').replace(/\D/g, '').replace(/^88(?=01)/, ''); return /^01[3-9]\d{8}$/.test(d) ? d : ''; };
const hash = (s) => crypto.createHash('sha256').update('scbd-rate:' + s).digest('hex').slice(0, 24);
const clientIp = (req) => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || 'unknown').trim();
function readBody(req) { let b = req.body; try { if (typeof b !== 'object' || !b) b = JSON.parse(b || '{}'); } catch (e) { b = {}; } return b; }

// Rate limit using the database: max `limit` hits per `windowMs` for this key
async function rateLimit(bucket, key, limit, windowMs) {
  const path = `rate/${bucket}/${hash(key)}`, now = Date.now();
  const cur = (await dbGet(path)) || {};
  const hits = (Array.isArray(cur.hits) ? cur.hits : []).filter(t => now - t < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  await dbPut(path, { hits, updated: now });
  return true;
}

/* ---------- Order email (Resend) ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function sendOrderEmail(o) {
  const KEY = process.env.RESEND_API_KEY; if (!KEY) return false;
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
    const r = await call('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], subject: `New order ${o.orderNo} — ${taka(o.total)} — ${o.customer.name}`.slice(0, 180), text, html,
        ...(o.customer.email ? { reply_to: o.customer.email } : {}) }) }, 8000);
    if (!r.ok) console.error('Order email failed', r.status, r.raw.slice(0, 200));
    return r.ok;
  } catch (e) { console.error('Order email error', e); return false; }
}

module.exports = { call, db, dbGet, dbPatch, dbPut, pushKey, verifyUser, normPhone, clientIp, readBody, rateLimit, sendOrderEmail, esc };
