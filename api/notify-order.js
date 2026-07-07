// api/notify-order.js
//
// POST /api/notify-order — sends an email notification. Currently used to
// notify Ricardo whenever an order is sent to backorder ("Enviado").
//
// Uses Resend (https://resend.com) because it needs no SMTP setup, no app
// passwords, and has a free tier (100 emails/day) that's more than enough
// for this volume.
//
// ─── One-time setup ─────────────────────────────────────────────────────
//   1. Create a free account at https://resend.com (email + password,
//      no credit card needed for the free tier).
//   2. Dashboard → API Keys → "Create API Key" → copy the key it gives you
//      (starts with "re_"). You only see it once, so save it somewhere.
//   3. In Vercel: your project → Settings → Environment Variables, add:
//        RESEND_API_KEY     = <the key from step 2>
//        NOTIFY_EMAIL_TO    = <the email address that should receive these>
//        NOTIFY_EMAIL_FROM  = onboarding@resend.dev   (see note below)
//   4. Redeploy (env var changes need a redeploy to take effect).
//
// ─── Note on NOTIFY_EMAIL_FROM ──────────────────────────────────────────
// Resend only lets you send FROM a domain you've verified with them. Until
// you verify your own domain (Resend dashboard → Domains → add
// cedriambar.pt or whichever you use, then add the DNS records they give
// you), use their shared address "onboarding@resend.dev" as the sender —
// it works immediately with zero setup, but Resend restricts it to only
// deliver TO the email address you signed up to Resend with. That's fine
// for this use case (it's just going to your own inbox). If down the line
// you want it to go to more people or a nicer "from" name, verify a domain
// and switch NOTIFY_EMAIL_FROM to something like
// "encomendas@cedriambar.pt".
// ─────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.NOTIFY_EMAIL_TO;
  const from   = process.env.NOTIFY_EMAIL_FROM || 'onboarding@resend.dev';

  if (!apiKey || !to) {
    console.error('notify-order: missing RESEND_API_KEY or NOTIFY_EMAIL_TO env vars');
    res.status(500).json({ error: 'Email not configured on the server' });
    return;
  }

  const { subject, html } = req.body || {};
  if (!subject || !html) {
    res.status(400).json({ error: 'subject and html are required' });
    return;
  }

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to, subject, html })
    });

    if (!resendRes.ok) {
      const errBody = await resendRes.text().catch(() => '');
      throw new Error(`Resend API error (${resendRes.status}): ${errBody}`);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('notify-order failed:', err);
    res.status(500).json({ error: err.message });
  }
};
