// POST /api/order — the ONLY way an order is created.
// Prices come from products.json on the server (the browser's prices are ignored),
// bots are blocked, and the order + email alert are saved/sent here.
//
// Body: { items:[{id,size,color,qty}], customer:{name,phone,email,address}, payment:{method,trx}, idToken?, hp, ms }
// Needs FIREBASE_SERVICE_ACCOUNT (and RESEND_API_KEY for the email) in Vercel.

const S = require('./_shared');

let productCache = { at: 0, list: null };
async function loadProducts(req) {
  if (productCache.list && Date.now() - productCache.at < 60000) return productCache.list;
  const site = (process.env.SITE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/+$/, '');
  const r = await S.call(`${site}/products.json?v=${Date.now()}`, {}, 10000);
  if (!r.ok || !Array.isArray(r.json)) throw new Error('Could not load the product list');
  productCache = { at: Date.now(), list: r.json };
  return r.json;
}
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function makeOrderNo() {
  const d = new Date(Date.now() + 6 * 3600e3);   // Bangladesh date
  const p = (n) => String(n).padStart(2, '0');
  const r = [...require('crypto').randomBytes(4)].map(b => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[b % 36]).join('');
  return `SCB-${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${r}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = S.readBody(req);
  const fail = (status, error) => res.status(status).json({ error });
  try {
    // ---- 1. bot checks: hidden trap field must be empty, form can't be filled in under 3 seconds
    if (b.hp) return fail(400, 'Could not place the order.');
    if (!(Number(b.ms) >= 3000)) return fail(400, 'Please take a moment to check your details, then tap Confirm again.');

    // ---- 2. validate customer & payment
    const c = b.customer || {}, pay = b.payment || {};
    const customer = { name: clip(c.name, 80), phone: S.normPhone(c.phone), email: clip(c.email, 100).toLowerCase(), address: clip(c.address, 300) };
    if (customer.name.length < 2) return fail(400, 'Please enter your name.');
    if (!customer.phone) return fail(400, 'Please enter a valid Bangladeshi phone number (01XXXXXXXXX).');
    if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customer.email)) return fail(400, 'Please enter a valid email, or leave it empty.');
    if (customer.address.length < 8) return fail(400, 'Please enter your full delivery address.');
    const method = ['bKash', 'Nagad'].includes(pay.method) ? pay.method : '';
    const trx = clip(pay.trx, 40).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!method) return fail(400, 'Please choose bKash or Nagad.');
    if (trx.length < 4) return fail(400, 'Please enter your TrxID / payment reference.');

    // ---- 3. rebuild the cart from the real product list (prices can't be changed in the browser)
    const raw = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
    if (!raw.length) return fail(400, 'Your bag is empty.');
    const products = await loadProducts(req);
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
    const subtotal = items.reduce((n, l) => n + l.lineTotal, 0);
    const total = subtotal;   // delivery is FREE

    // ---- 4. rate limits (per network and per phone number)
    const ip = S.clientIp(req);
    if (!(await S.rateLimit('ip', ip, 30, 3600e3))) return fail(429, 'Too many orders from this network. Please try again in an hour or message us.');
    if (!(await S.rateLimit('phone', customer.phone, 6, 24 * 3600e3))) return fail(429, 'Too many orders for this phone number today. Please message us to order more.');

    // ---- 5. who is ordering (signed-in customers get the order in My Orders)
    const user = b.idToken ? await S.verifyUser(b.idToken) : null;

    // ---- 6. save
    let orderNo = makeOrderNo();
    for (let i = 0; i < 3 && (await S.dbGet('orderStatus/' + orderNo)); i++) orderNo = makeOrderNo();
    const key = S.pushKey(), now = Date.now();
    const order = { orderNo, source: 'website', customer, payment: { method, trx }, items, subtotal, delivery: 0, total,
      uid: user ? user.uid : null, status: 'Pending', createdAt: now };
    const status = { status: 'Pending', createdAt: now, total, itemCount: items.reduce((n, l) => n + l.qty, 0) };
    const upd = { [`orders/${key}`]: order, [`orderStatus/${orderNo}`]: status };
    if (user) upd[`userOrders/${user.uid}/${key}`] = order;
    await S.dbPatch('', upd);

    // ---- 7. email alert to the shop
    const emailed = await S.sendOrderEmail(order);
    return res.status(200).json({ ok: true, orderNo, total, subtotal, emailed });
  } catch (err) {
    console.error('Order error:', err);
    return fail(err.setup ? 503 : 502, err.setup ? err.message : 'Could not place the order right now. Please try again.');
  }
};
