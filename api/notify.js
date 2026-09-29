// POST /api/notify  { text, orderNo, saved }
// Sends each new website order to the shop owner's WhatsApp (admin notification only).
// The customer is never sent to WhatsApp. No packages needed.
//
// Vercel → Project → Settings → Environment Variables (set at least one key):
//   CALLMEBOT_APIKEY   free — key from the CallMeBot WhatsApp bot
//   TEXTMEBOT_APIKEY   backup — key from textmebot.com ($1/month, 2-day free trial)
//   NOTIFY_PHONE       WhatsApp number that receives the alerts, with 88
//                      (default 8801786789182)
// If both keys are set, CallMeBot is tried first and TextMeBot is used only if it fails.

const PHONE = '+' + String(process.env.NOTIFY_PHONE || '8801786789182').replace(/\D/g, '');
const seen = new Map();   // orderNo -> time, stops duplicate sends on the same server

async function get(url) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 9000);
  try { const r = await fetch(url, { signal: ctrl.signal }); return { ok: r.ok, status: r.status, body: await r.text() }; }
  finally { clearTimeout(timer); }
}
const BAD = /(apikey is (invalid|wrong|not valid)|invalid apikey|not (been )?activated|invalid (phone|recipient)|not connected|disconnected|expired)/i;

async function viaCallMeBot(message) {
  const r = await get(`https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(PHONE)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(process.env.CALLMEBOT_APIKEY)}`);
  const reply = r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!r.ok || BAD.test(reply)) throw new Error('CallMeBot: ' + (reply || r.status));
}
async function viaTextMeBot(message) {
  const r = await get(`https://api.textmebot.com/send.php?recipient=${encodeURIComponent(PHONE)}&apikey=${encodeURIComponent(process.env.TEXTMEBOT_APIKEY)}&text=${encodeURIComponent(message)}`);
  const reply = r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!r.ok || BAD.test(reply)) throw new Error('TextMeBot: ' + (reply || r.status));
}

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

  const header = body.saved === false ? '⚠️ Not saved in the dashboard — keep this message.\n\n' : '';
  const message = header + text.replace(/\nPlease confirm my order\. Thank you\.\s*$/, '');

  const senders = [];
  if (process.env.CALLMEBOT_APIKEY) senders.push(['callmebot', viaCallMeBot]);
  if (process.env.TEXTMEBOT_APIKEY) senders.push(['textmebot', viaTextMeBot]);
  if (!senders.length) return res.status(503).json({ sent: false, error: 'WhatsApp alerts are not set up (add CALLMEBOT_APIKEY or TEXTMEBOT_APIKEY in Vercel).' });

  const errors = [];
  for (const [name, send] of senders) {
    try { await send(message); seen.set(orderNo, now); return res.status(200).json({ sent: true, via: name }); }
    catch (err) { console.error('WhatsApp alert failed:', err.message || err); errors.push(String(err.message || err)); }
  }
  return res.status(502).json({ sent: false, error: errors.join(' | ') });
};
