// lib/stockAlerts.js
//
// Fires a real-time email (via the same Resend integration as
// api/notify-order.js) the moment a SKU's *available* stock
// (STOCK - RESERVADO) drops below its STOCK MÍNIMO threshold.
//
// "Once per crossing": this only compares the before/after of the write
// that just happened — there's no persisted "already alerted" flag. If a
// SKU is already below its threshold and drops further (another order,
// another pick), no repeat email fires, since old was already < mínimo.
// If it's later restocked back above the threshold and drops below again,
// that's a new crossing and it alerts again. This needs no extra sheet
// column or state — just call it with the old/new available numbers from
// whatever write just happened.
//
// ─── Setup ──────────────────────────────────────────────────────────────
// Reuses RESEND_API_KEY and NOTIFY_EMAIL_FROM from the notify-order setup.
// Optionally set LOW_STOCK_EMAIL_TO in Vercel if these alerts should go
// somewhere other than NOTIFY_EMAIL_TO (defaults to it if unset).
// Threshold per SKU is set by editing the "STOCK MÍNIMO" column (P) of the
// Etiquetas sheet directly — blank means "never alert for this SKU".
// ───────────────────────────────────────────────────────────────────────

const { getNotifyRecipients } = require('./users');

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

  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.NOTIFY_EMAIL_FROM || 'onboarding@resend.dev';

  // Recipients: anyone who opted in to low-stock alerts in the
  // Utilizadores tab (Settings screen), falling back to the fixed
  // LOW_STOCK_EMAIL_TO/NOTIFY_EMAIL_TO env vars so this keeps working
  // before anyone's set that up.
  let to = [];
  try {
    to = await getNotifyRecipients('lowstock');
  } catch (err) {
    console.error('low-stock alert: failed to load opted-in recipients, falling back to env var', err);
  }
  if (to.length === 0) {
    const envTo = process.env.LOW_STOCK_EMAIL_TO || process.env.NOTIFY_EMAIL_TO;
    if (envTo) to = [envTo];
  }

  if (!apiKey || to.length === 0) {
    console.error(`low-stock alert: RESEND_API_KEY/LOW_STOCK_EMAIL_TO (or NOTIFY_EMAIL_TO) not set — skipped alert for ${sku}`);
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;color:#111;max-width:480px;margin:0 auto;">
      <h2 style="margin:0 0 8px;">Stock baixo — ${sku}</h2>
      <p style="margin:0 0 12px;color:#555;font-size:14px;">${descricao || ''}</p>
      <p style="font-size:14px;margin:0 0 4px;">
        Disponível agora: <strong>${fmtNum(newAvailable)}</strong>
      </p>
      <p style="font-size:13px;color:#888;margin:0;">Mínimo definido: ${fmtNum(stockMinimo)}</p>
    </div>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        subject: `Stock baixo — ${sku}${descricao ? ' · ' + descricao : ''}`,
        html
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`low-stock alert: Resend API error (${res.status}): ${body}`);
    }
  } catch (err) {
    console.error('low-stock alert: failed to send email:', err);
  }
}

module.exports = { maybeSendLowStockAlert };
