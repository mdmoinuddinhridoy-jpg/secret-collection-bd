// POST /api/claim  { idToken, orderNo, phone }
// Adds a guest order to the signed-in customer's account — only if the Order ID AND the phone number match.
const S = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = S.readBody(req);
  const fail = (status, error) => res.status(status).json({ error });
  try {
    const user = await S.verifyUser(b.idToken);
    if (!user) return fail(401, 'Please sign in again.');
    const orderNo = String(b.orderNo || '').trim().toUpperCase();
    const phone = S.normPhone(b.phone);
    if (!/^SCB-\d{6}-[A-Z0-9]{4}$/.test(orderNo)) return fail(400, 'Please enter your Order ID, e.g. SCB-260929-AB12.');
    if (!phone) return fail(400, 'Please enter the phone number used for the order (01XXXXXXXXX).');
    if (!(await S.rateLimit('claim', user.uid, 10, 3600e3))) return fail(429, 'Too many attempts. Please try again in an hour.');

    const found = await S.dbGet('orders', `&orderBy=${encodeURIComponent('"orderNo"')}&equalTo=${encodeURIComponent(JSON.stringify(orderNo))}`);
    const entry = found && Object.entries(found)[0];
    // same answer for "not found" and "wrong phone", so order IDs can't be probed
    if (!entry || S.normPhone(entry[1].customer && entry[1].customer.phone) !== phone) return fail(404, 'No order found with this Order ID and phone number.');
    const [key, order] = entry;
    if (order.uid && order.uid !== user.uid) return fail(409, 'This order is already linked to another account.');

    const upd = { [`orders/${key}/uid`]: user.uid, [`userOrders/${user.uid}/${key}`]: { ...order, uid: user.uid } };
    await S.dbPatch('', upd);
    return res.status(200).json({ ok: true, orderNo });
  } catch (err) {
    console.error('Claim error:', err);
    return fail(err.setup ? 503 : 502, err.setup ? err.message : 'Could not add the order right now. Please try again.');
  }
};
