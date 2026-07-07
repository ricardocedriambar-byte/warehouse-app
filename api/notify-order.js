// api/notify-order.js
//
// POST /api/notify-order — sends an email notification with the filled
// "Nota de Encomenda" PDF attached. Currently used to notify Ricardo
// whenever an order is sent to backorder ("Enviado").
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
//   3. Run `npm install pdf-lib` in the project (needed by
//      lib/pdf-order-note.js to fill the PDF template).
//   4. Place the template file at lib/nota-encomenda-template.pdf
//      (provided alongside this file).
//   5. In Vercel: your project → Settings → Environment Variables, add:
//        RESEND_API_KEY     = <the key from step 2>
//        NOTIFY_EMAIL_TO    = <the email address that should receive these>
//        NOTIFY_EMAIL_FROM  = onboarding@resend.dev   (see note below)
//   6. Redeploy (env var and file changes need a redeploy to take effect).
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

const { buildOrderNotePdf } = require('../lib/pdf-order-note');

function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function buildEmailHTML(order, client) {
  const date  = order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-PT') : new Date().toLocaleDateString('pt-PT');
  const lines = order.lines || [];
  const total = lines.reduce((sum, l) => sum + (l.qtyOrdered || 0) * (l.unitPrice || 0), 0);

  const rows = lines.map(l => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;">${l.sku || '—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;">${l.descricao || ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:center;">${fmtNum(l.qtyOrdered, 0)} ${l.unidade || 'un'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:right;">${fmtNum(l.unitPrice)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:right;">${fmtNum((l.qtyOrdered || 0) * (l.unitPrice || 0))}</td>
    </tr>`).join('');

  return `
    <div style="font-family:Arial,sans-serif;color:#111;max-width:600px;margin:0 auto;">
      <h2 style="margin:0 0 4px;">Nova encomenda enviada</h2>
      <p style="margin:0 0 16px;color:#555;font-size:14px;">
        <strong>${order.orderId || ''}</strong> · ${date}<br/>
        Cliente: ${client?.name || order.clientName || '—'}<br/>
        Vendedor: ${order.salesperson || '—'}
        ${order.orderNotes ? `<br/>Notas: ${order.orderNotes}` : ''}
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f5f5f5;text-align:left;">
            <th style="padding:6px 8px;">SKU</th>
            <th style="padding:6px 8px;">Descrição</th>
            <th style="padding:6px 8px;text-align:center;">Qtd</th>
            <th style="padding:6px 8px;text-align:right;">Preço</th>
            <th style="padding:6px 8px;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="4" style="padding:8px;text-align:right;"><strong>Total</strong></td>
            <td style="padding:8px;text-align:right;"><strong>${fmtNum(total)}</strong></td>
          </tr>
        </tfoot>
      </table>
      <p style="font-size:12px;color:#888;margin-top:16px;">Nota de encomenda em anexo (PDF).</p>
    </div>`;
}

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

  const { order, client } = req.body || {};
  if (!order) {
    res.status(400).json({ error: 'order is required' });
    return;
  }

  try {
    const pdfBytes  = await buildOrderNotePdf(order, client || {});
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to,
        subject: `Nova encomenda ${order.orderId || ''} — ${client?.name || order.clientName || 'cliente'}`,
        html: buildEmailHTML(order, client),
        attachments: [{
          filename: `nota_encomenda_${order.orderId || 'sem_numero'}.pdf`,
          content: pdfBase64
        }]
      })
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
