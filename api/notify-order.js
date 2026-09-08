// api/notify-order.js
//
// POST /api/notify-order — sends a push notification whenever an order is
// sent to backorder ("Enviado") or an already-sent order is edited.
//
// This used to send an email (via Resend) with the filled "Nota de
// Encomenda" PDF attached. Push notifications can't carry attachments, so
// this version just notifies with a title/body — whoever gets it opens the
// app to see the order and print/view the ficha from there. It also can't
// deep-link to the specific order (the app has no URL-based view routing),
// so tapping the notification just opens/focuses the app.
//
// ─── Setup ──────────────────────────────────────────────────────────────
// Needs VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY set — see lib/push.js for the
// one-time setup. Recipients are anyone with "NotificarEncomendas" checked
// in the Utilizadores tab (Settings screen) who has enabled push
// notifications on at least one device.
// ───────────────────────────────────────────────────────────────────────

const { getNotifyRecipientUserIds } = require('../lib/users');
const { sendPushToUsers } = require('../lib/push');

function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { order, client } = req.body || {};
  if (!order) {
    res.status(400).json({ error: 'order is required' });
    return;
  }

  try {
    const userIds = await getNotifyRecipientUserIds('orders');
    if (userIds.length === 0) {
      // Nobody opted in yet — not an error, just nothing to do.
      res.status(200).json({ ok: true, sent: 0 });
      return;
    }

    const lines = order.lines || [];
    const lineNet = l => (l.qtyOrdered || 0) * (l.unitPrice || 0) * (1 - (l.discountPct || 0) / 100);
    const total = lines.reduce((sum, l) => sum + lineNet(l), 0);
    const clientName = client?.name || order.clientName || 'cliente';

    const result = await sendPushToUsers(userIds, {
      title: `Nova encomenda ${order.orderId || ''}`,
      body: `${clientName} · ${lines.length} artigo${lines.length !== 1 ? 's' : ''} · ${fmtNum(total)} €`,
      tag: `order-${order.orderId || ''}`
    });

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('notify-order failed:', err);
    res.status(500).json({ error: err.message });
  }
};
