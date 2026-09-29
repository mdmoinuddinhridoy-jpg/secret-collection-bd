// POST /api/steadfast   (admin only — checked with the admin's Firebase login)
//   { action: 'balance' }                                   → { balance }
//   { action: 'create', parcel: { invoice, recipient_name, recipient_phone, recipient_address,
//                                 cod_amount, note, item_description, total_lot, recipient_email } }
//                                                           → { consignment: { consignment_id, tracking_code, status, … } }
//   { action: 'status', consignmentId }                     → { delivery_status }
//
// Vercel → Project → Settings → Environment Variables:
//   STEADFAST_API_KEY      from Steadfast merchant panel → API
//   STEADFAST_SECRET_KEY   from Steadfast merchant panel → API
//   STEADFAST_BASE_URL     optional (default https://portal.packzy.com/api/v1)
// No packages needed.

const BASE = (process.env.STEADFAST_BASE_URL || 'https://portal.packzy.com/api/v1').replace(/\/+$/, '');
const FIREBASE_WEB_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyB_xMPnzuNieOtMZWE3ozmdBa0jxGKHkO4';
const ADMIN_EMAILS = ['md.moinuddin.hridoy@gmail.com'];

async function call(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch (e) {}
    return { ok: r.ok, status: r.status, json, raw };
  } finally { clearTimeout(timer); }
}

// Verify the Firebase ID token with Google and make sure it is the admin
async function isAdmin(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 5000) return false;
  const r = await call(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  }, 8000);
  const email = r.ok && r.json && r.json.users && r.json.users[0] && String(r.json.users[0].email || '').toLowerCase();
  return !!email && ADMIN_EMAILS.includes(email);
}

const sf = (path, opts = {}) => call(BASE + path, {
  ...opts,
  headers: { 'Api-Key': process.env.STEADFAST_API_KEY, 'Secret-Key': process.env.STEADFAST_SECRET_KEY, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) }
});
const sfError = (r) => {
  const j = r.json || {};
  if (j.errors && typeof j.errors === 'object') return Object.entries(j.errors).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join(' · ');
  return j.message || j.error || (r.raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || `Steadfast error ${r.status}`;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body = req.body;
  try { if (typeof body !== 'object' || !body) body = JSON.parse(body || '{}'); } catch (e) { body = {}; }

  try {
    if (!(await isAdmin(body.idToken))) return res.status(401).json({ error: 'Admin login required. Please sign in again.' });
    if (!process.env.STEADFAST_API_KEY || !process.env.STEADFAST_SECRET_KEY)
      return res.status(503).json({ error: 'Steadfast is not connected yet — add STEADFAST_API_KEY and STEADFAST_SECRET_KEY in Vercel, then redeploy.' });

    if (body.action === 'balance') {
      const r = await sf('/get_balance');
      if (!r.ok || !r.json || (r.json.status && Number(r.json.status) !== 200)) return res.status(502).json({ error: sfError(r) });
      return res.status(200).json({ balance: r.json.current_balance });
    }

    if (body.action === 'status') {
      const id = String(body.consignmentId || '').replace(/\D/g, '');
      if (!id) return res.status(400).json({ error: 'Missing consignment ID' });
      const r = await sf('/status_by_cid/' + id);
      if (!r.ok || !r.json || (r.json.status && Number(r.json.status) !== 200)) return res.status(502).json({ error: sfError(r) });
      return res.status(200).json({ delivery_status: r.json.delivery_status });
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

      if (!parcel.invoice) return res.status(400).json({ error: 'Missing invoice (order number)' });
      if (!parcel.recipient_name) return res.status(400).json({ error: 'Missing customer name' });
      if (!/^01[3-9]\d{8}$/.test(phone)) return res.status(400).json({ error: 'Customer phone must be 11 digits (01XXXXXXXXX)' });
      if (parcel.recipient_address.length < 5) return res.status(400).json({ error: 'Missing delivery address' });

      const r = await sf('/create_order', { method: 'POST', body: JSON.stringify(parcel) });
      const c = r.json && r.json.consignment;
      if (!r.ok || !c || (r.json.status && Number(r.json.status) !== 200)) return res.status(502).json({ error: sfError(r) });
      return res.status(200).json({ consignment: c, message: r.json.message });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Steadfast error:', err);
    return res.status(502).json({ error: err.name === 'AbortError' ? 'Steadfast did not respond in time. Please try again.' : 'Could not reach Steadfast. Please try again.' });
  }
};
