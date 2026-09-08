// lib/stockAlerts.js
//
// Fires a push notification (via lib/push.js) the moment a SKU's
// *available* stock (STOCK - RESERVADO) drops below its STOCK MÍNIMO
// threshold. Used to send Resend emails; replaced with Web Push so no
// email service/account is needed and alerts land as a phone/desktop
// notification instead.
//
// "Once per crossing": this only compares the before/after of the write
// that just happened — there's no persisted "already alerted" flag. If a
// SKU is already below its threshold and drops further (another order,
// another pick), no repeat notification fires, since old was already <
// mínimo. If it's later restocked back above the threshold and drops below
// again, that's a new crossing and it alerts again. This needs no extra
// sheet column or state — just call it with the old/new available numbers
// from whatever write just happened.
//
// ─── Setup ──────────────────────────────────────────────────────────────
// Needs VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY set — see lib/push.js for the
// one-time setup. Recipients are anyone with "NotificarStockBaixo" checked
// in the Utilizadores tab (Settings screen) who has enabled push
// notifications on at least one device.
// Threshold per SKU is set by editing the "STOCK MÍNIMO" column (P) of the
// Etiquetas sheet directly — blank means "never alert for this SKU".
// ───────────────────────────────────────────────────────────────────────

const { getNotifyRecipientUserIds } = require('./users');
const { sendPushToUsers } = require('./push');

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('pt-PT', { maximumFractionDigits: 2 });
}

async function maybeSendLowStockAlert({ sku, descricao, oldAvailable, newAvailable, stockMinimo }) {
  if (stockMinimo === null || stockMinimo === undefined) return; // no threshold set
  if (oldAvailable === null || oldAvailable === undefined) return;
  if (newAvailable === null || newAvailable === undefined) return;

  // Only a downward crossing fires — was at/above the threshold, now below it.
  const crossed = oldAvailable >= stockMinimo && newAvailable < stockMinimo;
  if (!crossed) return;

  try {
    const userIds = await getNotifyRecipientUserIds('lowstock');
    if (userIds.length === 0) return;

    await sendPushToUsers(userIds, {
      title: `Stock baixo — ${sku}`,
      body: `${descricao ? descricao + ' · ' : ''}Disponível: ${fmtNum(newAvailable)} (mínimo ${fmtNum(stockMinimo)})`,
      tag: `lowstock-${sku}`,
      // Consumed by public/app.js's applyPendingPushTarget/navigateToPushTargetString
      // when the notification is tapped — opens straight to this item.
      url: `/?push=item:${encodeURIComponent(sku)}`
    });
  } catch (err) {
    console.error('low-stock alert: failed to send push:', err);
  }
}

module.exports = { maybeSendLowStockAlert };
