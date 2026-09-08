// api/notify-order.js
//
// POST /api/notify-order — notifies whoever opted in that an order was
// sent to backorder ("Enviado") or an already-sent order was edited.
// Runs two channels, each best-effort (one failing doesn't block the
// other or the order itself, which is already saved by this point):
//
//   - Push: near-instant, and tapping the notification deep-links
//     straight to that order (see lib/push.js and public/sw.js's
//     notificationclick/message handling).
//   - Email (via Resend): slower, but carries the filled "Nota de
//     Encomenda" PDF attachment — something a push payload can't do.
//
// ─── Email setup (only needed for the email channel) ───────────────────
//   1. Free account at https://resend.com (no credit card for free tier).
//   2. Dashboard → API Keys → "Create API Key" → copy it (starts "re_").
//   3. In Vercel: Settings → Environment Variables, add:
//        RESEND_API_KEY     = <the key from step 2>
//        NOTIFY_EMAIL_FROM  = onboarding@resend.dev   (see note below)
//        NOTIFY_EMAIL_TO    = <fallback address, optional>
//   4. Redeploy (env var changes need a redeploy to take effect).
//
// Resend's shared "onboarding@resend.dev" sender only delivers to the
// address you signed up to Resend with. Verify your own domain (Resend
// dashboard → Domains) and switch NOTIFY_EMAIL_FROM to it once you want
// this going to more people or from a nicer address.
// ─────────────────────────────────────────────────────────────────────────
//
// ─── Push setup ─────────────────────────────────────────────────────────
// Needs VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY set — see lib/push.js.
// ───────────────────────────────────────────────────────────────────────

const { buildOrderNotePdf } = require('../lib/pdf-order-note');
const { getNotifyRecipients, getNotifyRecipientUserIds } = require('../lib/users');
const { sendPushToUsers } = require('../lib/push');

function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function buildEmailHTML(order, client) {
  const date  = order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-PT') : new Date().toLocaleDateString('pt-PT');
  const lines = order.lines || [];
  const lineNet = l => (l.qtyOrdered || 0) * (l.unitPrice || 0) * (1 - (l.discountPct || 0) / 100);
  const total = lines.reduce((sum, l) => sum + lineNet(l), 0);

  const rows = lines.map(l => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;">${l.sku || '—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;">${l.descricao || ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:center;">${fmtNum(l.qtyOrdered, 0)} ${l.unidade || 'un'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:right;">${fmtNum(l.unitPrice)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:right;">${l.discountPct ? fmtNum(l.discountPct, 0) + '%' : '—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:right;">${fmtNum(lineNet(l))}</td>
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
            <th style="padding:6px 8px;text-align:right;">Desc.</th>
            <th style="padding:6px 8px;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="5" style="padding:8px;text-align:right;"><strong>Total</strong></td>
            <td style="padding:8px;text-align:right;"><strong>${fmtNum(total)}</strong></td>
          </tr>
        </tfoot>
      </table>
      <p style="font-size:12px;color:#888;margin-top:16px;">Nota de encomenda em anexo (PDF).</p>
    </div>`;
}

async function sendEmail(order, client) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.NOTIFY_EMAIL_FROM || 'onboarding@resend.dev';

  let to = [];
  try {
    to = await getNotifyRecipients('orders');
  } catch (err) {
    console.error('notify-order: failed to load opted-in recipients, falling back to NOTIFY_EMAIL_TO', err);
  }
  if (to.length === 0 && process.env.NOTIFY_EMAIL_TO) to = [process.env.NOTIFY_EMAIL_TO];

  if (!apiKey || to.length === 0) {
    console.error('notify-order: missing RESEND_API_KEY or no recipients configured — skipping email');
    return { sent: false };
  }

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

  return { sent: true, to };
}

async function sendPush(order, client) {
  const userIds = await getNotifyRecipientUserIds('orders');
  if (userIds.length === 0) return { sent: 0 };

  const lines = order.lines || [];
  const lineNet = l => (l.qtyOrdered || 0) * (l.unitPrice || 0) * (1 - (l.discountPct || 0) / 100);
  const total = lines.reduce((sum, l) => sum + lineNet(l), 0);
  const clientName = client?.name || order.clientName || 'cliente';

  return sendPushToUsers(userIds, {
    title: `Nova encomenda ${order.orderId || ''}`,
    body: `${clientName} · ${lines.length} artigo${lines.length !== 1 ? 's' : ''} · ${fmtNum(total)} €`,
    tag: `order-${order.orderId || ''}`,
    // Consumed by public/app.js's applyPendingPushTarget/navigateToPushTargetString
    // when the notification is tapped — opens straight to this order.
    url: `/?push=order:${encodeURIComponent(order.orderId || '')}`
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { order, client } = req.body || {};
  if (!order) {
    res.status(400).json({ error: 'order is required' });
    return;
  }

  const [pushResult, emailResult] = await Promise.allSettled([
    sendPush(order, client),
    sendEmail(order, client)
  ]);

  if (pushResult.status === 'rejected') console.error('notify-order: push failed:', pushResult.reason);
  if (emailResult.status === 'rejected') console.error('notify-order: email failed:', emailResult.reason);

  // Only fail the request outright if BOTH channels failed — the order
  // itself is already saved by the time this runs, so partial delivery
  // (e.g. push worked but email isn't configured yet) shouldn't read as
  // an error to whoever sent the order.
  if (pushResult.status === 'rejected' && emailResult.status === 'rejected') {
    res.status(500).json({ error: 'Push e email falharam ambos' });
    return;
  }

  res.status(200).json({
    ok: true,
    push: pushResult.status === 'fulfilled' ? pushResult.value : null,
    email: emailResult.status === 'fulfilled' ? emailResult.value : null
  });
};
