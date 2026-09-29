// POST /api/notify  { text, orderNo, saved }
// Sends the new-order message to the shop's own WhatsApp number (admin notification only).
// The customer is never sent to WhatsApp. No packages needed.
//
// Vercel → Project → Settings → Environment Variables:
//   CALLMEBOT_APIKEY   the key CallMeBot sent you on WhatsApp            (free, recommended)
//   NOTIFY_PHONE       optional, default 8801786789182 (must be the number you activated)
//   TEXTMEBOT_APIKEY   optional alternative to CallMeBot (textmebot.com)

const PHONE = '+' + String(process.env.NOTIFY_PHONE || '8801786789182').replace(/\D/g, '');
const seen = new Map();   // orderNo -> time, stops duplicate sends on the same server

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body = req.body;
  try { if (typeof body !== 'object' || !body) body = JSON.parse(body || '{}'); } catch (e) { body = {}; }

  const text = String(body.text || '');
  const orderNo = String(body.orderNo || '').slice(0, 40);
  // only real order messages from the website checkout
  if (!/^\*NEW ORDER — SECRET COLLECTION BD\*/.test(text) || text.length > 3500 || !/^SCB-\d{6}-[A-Z0-9]{4}$/.test(orderNo) || !text.includes(orderNo))
    return res.status(400).json({ error: 'Invalid order message' });

  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 3600e3) seen.delete(k);
  if (seen.has(orderNo)) return res.status(200).json({ sent: true, duplicate: true });

  const header = body.saved === false
    ? '⚠️ Not saved in the dashboard — keep this message.\n\n'
    : '';
  const message = header + text.replace(/\nPlease confirm my order\. Thank you\.\s*$/, '');

  const CMB = process.env.CALLMEBOT_APIKEY, TMB = process.env.TEXTMEBOT_APIKEY;
  if (!CMB && !TMB) return res.status(503).json({ sent: false, error: 'WhatsApp notifications are not set up (CALLMEBOT_APIKEY missing).' });

  const url = CMB
    ? `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(PHONE)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(CMB)}`
    : `https://api.textmebot.com/send.php?recipient=${encodeURIComponent(PHONE)}&apikey=${encodeURIComponent(TMB)}&text=${encodeURIComponent(message)}`;

  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(timer);
    const reply = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    // CallMeBot answers 200 even for some problems, so also look at the words
    const ok = r.ok && !/(apikey is (invalid|wrong|not valid)|invalid apikey|not (been )?activated|invalid (phone|recipient))/i.test(reply);
    if (!ok) { console.error('WhatsApp notify failed:', r.status, reply); return res.status(502).json({ sent: false, error: reply || 'Send failed' }); }
    seen.set(orderNo, now);
    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('WhatsApp notify error:', err);
    return res.status(502).json({ sent: false, error: 'Could not reach the WhatsApp service' });
  }
};
