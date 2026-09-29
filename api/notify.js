// POST /api/notify  { text, orderNo, saved }
// Emails each new website order to the shop owner (admin notification only).
// Uses Resend (resend.com, free: 3,000 emails/month). No packages needed.
//
// Vercel → Project → Settings → Environment Variables:
//   RESEND_API_KEY   your Resend API key (starts with re_)
//   NOTIFY_EMAIL     optional, where order emails go (default md.moinuddin.hridoy@gmail.com)
//                    Without your own domain in Resend, this must be the email you signed up to Resend with.
//   NOTIFY_FROM      optional, only after verifying your own domain in Resend,
//                    e.g. Secret Collection BD <orders@yourdomain.com>

const TO = process.env.NOTIFY_EMAIL || 'md.moinuddin.hridoy@gmail.com';
const FROM = process.env.NOTIFY_FROM || 'Secret Collection BD <onboarding@resend.dev>';
const seen = new Map();   // orderNo -> time, stops duplicate sends on the same server

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pick = (text, label) => { const m = text.match(new RegExp('^' + label + ':\\s*(.+)$', 'm')); return m ? m[1].trim() : ''; };

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

  const KEY = process.env.RESEND_API_KEY;
  if (!KEY) return res.status(503).json({ sent: false, error: 'Order emails are not set up (RESEND_API_KEY missing).' });

  const warn = body.saved === false ? '⚠️ Not saved in the dashboard — keep this email.\n\n' : '';
  const plain = (warn + text.replace(/\nPlease confirm my order\. Thank you\.\s*$/, '')).replace(/\*/g, '');
  const name = pick(text, 'Name'), phone = pick(text, 'Phone'), email = pick(text, 'Email');
  const total = (text.match(/TOTAL:\s*([^*\n]+?)\s*BDT/) || [])[1] || '';
  const subject = `New order ${orderNo} — ${total} — ${name}`.slice(0, 180);

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e5e5">
  <div style="background:#0F0F0F;color:#fff;padding:18px 22px;font-size:16px;letter-spacing:2px">NEW ORDER — SECRET COLLECTION BD</div>
  <div style="padding:22px;font-size:14px;line-height:1.6;color:#222">
    ${warn ? `<p style="background:#FFF4D6;padding:10px;margin:0 0 14px">${esc(warn.trim())}</p>` : ''}
    ${esc(text).replace(/\nPlease confirm my order\. Thank you\.\s*$/, '')
        .replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/━+/g, '<hr style="border:0;border-top:1px solid #eee">').replace(/\n/g, '<br>')}
    ${phone ? `<p style="margin-top:18px"><a href="tel:+88${esc(phone.replace(/\D/g, '').replace(/^88/, ''))}" style="background:#0F0F0F;color:#fff;padding:10px 16px;text-decoration:none;font-size:12px;letter-spacing:1px">CALL CUSTOMER</a></p>` : ''}
  </div></div>`;

  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [TO], subject, text: plain, html, ...(/^\S+@\S+\.\S+$/.test(email) ? { reply_to: email } : {}) })
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('Order email failed:', r.status, j); return res.status(502).json({ sent: false, error: j.message || 'Email failed' }); }
    seen.set(orderNo, now);
    return res.status(200).json({ sent: true, id: j.id });
  } catch (err) {
    console.error('Order email error:', err);
    return res.status(502).json({ sent: false, error: 'Could not reach the email service' });
  }
};
