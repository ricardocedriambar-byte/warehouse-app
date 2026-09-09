// lib/push.js
//
// Web Push notifications — replaces the old Resend email integration for
// both low-stock alerts (lib/stockAlerts.js) and order-sent notifications
// (api/notify-order.js).
//
// Web Push needs no third-party account: the app signs every notification
// itself with a VAPID key pair (a public/private key pair that identifies
// this server to the browser's push service — Google's for Chrome,
// Mozilla's for Firefox, Apple's for Safari, etc). Each device that opts
// in creates a "subscription" (an endpoint URL + two keys) which is stored
// here in a self-creating "PushSubscriptions" sheet tab, the same pattern
// used by the Utilizadores/Encomendas tabs elsewhere in this codebase.
//
// ─── One-time setup ─────────────────────────────────────────────────────
//   1. Generate a VAPID key pair once, e.g. by running:
//        npx web-push generate-vapid-keys
//      (or ask Claude to generate one for you).
//   2. In Vercel: your project → Settings → Environment Variables, add:
//        VAPID_PUBLIC_KEY   = <the public key>
//        VAPID_PRIVATE_KEY  = <the private key>
//        VAPID_SUBJECT      = mailto:you@example.com  (any contact URL/email
//                              the push services can use to reach you if
//                              your server is misbehaving — not shown to
//                              end users)
//   3. Redeploy (env var changes need a redeploy to take effect).
//
// A subscription only works for the site it was created on, so nothing
// else needs to change if you rotate keys — existing subscriptions just
// silently stop working and get cleaned up automatically (see
// sendPushToUsers below), and people get a fresh one next time they log in
// and the app finds none stored for that browser.
// ─────────────────────────────────────────────────────────────────────────

const webpush = require('web-push');
const { sheetsFetch } = require('./sheets');

const SUBS_TAB = 'PushSubscriptions';

const COLS = {
  ID: 0, USER_ID: 1, ENDPOINT: 2, P256DH: 3, AUTH: 4, USER_AGENT: 5, CREATED_AT: 6
};

let tabEnsured = false;
let vapidConfigured = false;
// Set whenever ensureVapid() returns false, so sendTestPush can tell
// someone *why* (missing env vars vs. malformed keys) instead of just
// failing silently like the fire-and-forget sendPushToUsers does.
let lastVapidError = null;

function ensureVapid() {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    lastVapidError = 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não estão definidas no servidor';
    return false;
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidConfigured = true;
    lastVapidError = null;
    return true;
  } catch (err) {
    // web-push throws synchronously here if a key is malformed — a common
    // cause is a stray newline/space left over from copy-pasting the value
    // into Vercel's env var field.
    lastVapidError = `Chaves VAPID inválidas: ${err.message}`;
    return false;
  }
}

async function ensureSubsTab() {
  if (tabEnsured) return;
  try {
    await sheetsFetch(`/values/${encodeURIComponent(`${SUBS_TAB}!A1`)}`);
  } catch (err) {
    if (String(err.message).includes('400') || String(err.message).includes('Unable to parse')) {
      await sheetsFetch(':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SUBS_TAB } } }] })
      }).catch(() => {});
      await sheetsFetch(
        `/values/${encodeURIComponent(`${SUBS_TAB}!A1`)}:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          body: JSON.stringify({
            values: [['ID', 'UserId', 'Endpoint', 'P256dh', 'Auth', 'UserAgent', 'CreatedAt']]
          })
        }
      );
    } else {
      throw err;
    }
  }
  tabEnsured = true;
}

function generateSubId() {
  return `SUB${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

// One row per (user, device/browser) — a person can be logged in on their
// phone and desktop at once, each with its own subscription. Upserts by
// endpoint, since the endpoint is what uniquely identifies a given
// browser's push channel; if the same browser re-subscribes (e.g. after
// clearing site data) it gets a new endpoint and a new row, and the old
// one is left to be cleaned up next time a send to it 404s/410s.
async function saveSubscription(userId, subscription, userAgent) {
  if (!subscription || !subscription.endpoint) throw new Error('subscription inválida');
  await ensureSubsTab();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${SUBS_TAB}!A2:G`)}`);
  const rows = data.values || [];
  const idx = rows.findIndex(r => r[COLS.ENDPOINT] === subscription.endpoint);

  const rowValues = [
    idx >= 0 ? (rows[idx][COLS.ID] || generateSubId()) : generateSubId(),
    userId || '',
    subscription.endpoint,
    subscription.keys?.p256dh || '',
    subscription.keys?.auth || '',
    userAgent || '',
    idx >= 0 ? (rows[idx][COLS.CREATED_AT] || new Date().toISOString()) : new Date().toISOString()
  ];

  const rowNumber = idx >= 0 ? idx + 2 : rows.length + 2;
  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [{ range: `${SUBS_TAB}!A${rowNumber}:G${rowNumber}`, values: [rowValues] }]
    })
  });
}

async function removeSubscriptionByEndpoint(endpoint) {
  if (!endpoint) return;
  await ensureSubsTab();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${SUBS_TAB}!A2:G`)}`);
  const rows = data.values || [];
  const idx = rows.findIndex(r => r[COLS.ENDPOINT] === endpoint);
  if (idx < 0) return;
  const rowNumber = idx + 2;
  await sheetsFetch(`/values/${encodeURIComponent(`${SUBS_TAB}!A${rowNumber}:G${rowNumber}`)}:clear`, { method: 'POST' });
}

// Sends the same {title, body, ...} payload to every stored subscription
// belonging to any of the given user IDs (one push per device). A
// subscription that the push service reports as gone (404/410 — the user
// uninstalled the PWA, cleared site data, etc) is removed automatically so
// this table doesn't accumulate dead rows forever.
async function sendPushToUsers(userIds, payload) {
  if (!Array.isArray(userIds) || userIds.length === 0) return { sent: 0, failed: 0 };
  if (!ensureVapid()) {
    console.error('push: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not configured — skipped push send');
    return { sent: 0, failed: 0 };
  }

  await ensureSubsTab();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${SUBS_TAB}!A2:G`)}`);
  const rows = data.values || [];
  const targets = rows.filter(r => r[COLS.ENDPOINT] && userIds.includes(r[COLS.USER_ID]));

  const body = JSON.stringify(payload);
  let sent = 0, failed = 0;

  await Promise.all(targets.map(async (row) => {
    const subscription = {
      endpoint: row[COLS.ENDPOINT],
      keys: { p256dh: row[COLS.P256DH], auth: row[COLS.AUTH] }
    };
    try {
      await webpush.sendNotification(subscription, body);
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscriptionByEndpoint(subscription.endpoint).catch(() => {});
      } else {
        console.error('push: failed to send to', subscription.endpoint, err.message);
      }
    }
  }));

  return { sent, failed };
}

// Diagnostic helper behind the "Enviar notificação de teste" button in
// Settings. sendPushToUsers is fire-and-forget and only logs failures
// server-side (nothing comes back to whoever triggered it), which makes
// "I'm not getting notifications" impossible to debug from the outside —
// this instead reports, per device, whether the send worked and the exact
// error when it didn't, so someone can actually see what's wrong.
async function sendTestPush(userId) {
  if (!userId) return { ok: false, reason: 'userId é obrigatório', devices: [] };

  if (!ensureVapid()) {
    return { ok: false, reason: lastVapidError || 'VAPID não configurado no servidor', devices: [] };
  }

  await ensureSubsTab();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${SUBS_TAB}!A2:G`)}`);
  const rows = data.values || [];
  const targets = rows.filter(r => r[COLS.ENDPOINT] && r[COLS.USER_ID] === userId);

  if (targets.length === 0) {
    return {
      ok: false,
      reason: 'Nenhum dispositivo subscrito para este utilizador neste servidor — ativa as notificações (Definições ou o pedido ao entrar) neste dispositivo primeiro',
      devices: []
    };
  }

  const payload = JSON.stringify({
    title: 'Notificação de teste',
    body: 'Se vês isto, as notificações push estão a funcionar neste dispositivo.',
    tag: 'test-notification'
  });

  const devices = [];
  for (const row of targets) {
    const subscription = {
      endpoint: row[COLS.ENDPOINT],
      keys: { p256dh: row[COLS.P256DH], auth: row[COLS.AUTH] }
    };
    try {
      await webpush.sendNotification(subscription, payload);
      devices.push({ userAgent: row[COLS.USER_AGENT] || '(desconhecido)', ok: true });
    } catch (err) {
      devices.push({
        userAgent: row[COLS.USER_AGENT] || '(desconhecido)',
        ok: false,
        error: err.body || err.message,
        statusCode: err.statusCode || null
      });
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscriptionByEndpoint(subscription.endpoint).catch(() => {});
      }
    }
  }

  return { ok: devices.some(d => d.ok), devices };
}

// Diagnostic helper for "the manual test button works but real alerts
// don't" — sendTestPush above always sends to the caller's own userId, so
// it only proves the delivery pipeline works. It says nothing about
// whether the *recipient resolution* that real alerts use
// (getNotifyRecipientUserIds in lib/users.js, driven by the notifyOrders/
// notifyLowStock checkboxes in Settings) actually finds anyone. This
// resolves recipients the exact same way maybeSendLowStockAlert and
// api/notify-order.js do, then sends to their subscribed devices (if any),
// reporting both who was resolved and what happened on send — so someone
// can tell, from one button tap, whether the break is "nobody is opted
// in" vs. "opted in but the push failed to send".
async function sendTestPushByKind(kind) {
  const { getAllUsers } = require('./users');
  const flag = kind === 'orders' ? 'notifyOrders' : 'notifyLowStock';

  const users = await getAllUsers({ includeInactive: false });
  const recipients = users.filter(u => u[flag]);

  if (recipients.length === 0) {
    return {
      ok: false,
      reason: kind === 'orders'
        ? 'Nenhum utilizador tem "Encomenda enviada" ativado em Definições — ninguém vai receber este alerta'
        : 'Nenhum utilizador tem "Stock baixo" ativado em Definições — ninguém vai receber este alerta',
      recipients: [],
      devices: []
    };
  }

  if (!ensureVapid()) {
    return {
      ok: false,
      reason: lastVapidError || 'VAPID não configurado no servidor',
      recipients: recipients.map(u => u.name),
      devices: []
    };
  }

  await ensureSubsTab();
  const data = await sheetsFetch(`/values/${encodeURIComponent(`${SUBS_TAB}!A2:G`)}`);
  const rows = data.values || [];
  const recipientIds = recipients.map(u => u.id);
  const targets = rows.filter(r => r[COLS.ENDPOINT] && recipientIds.includes(r[COLS.USER_ID]));

  const recipientsWithoutDevice = recipients.filter(
    u => !targets.some(r => r[COLS.USER_ID] === u.id)
  );

  if (targets.length === 0) {
    return {
      ok: false,
      reason: `${recipients.map(u => u.name).join(', ')} ${recipients.length === 1 ? 'está' : 'estão'} a receber este alerta, mas sem nenhum dispositivo com notificações ativadas — ativa as notificações neste dispositivo (Definições) com essa conta`,
      recipients: recipients.map(u => u.name),
      devices: []
    };
  }

  const payload = JSON.stringify({
    title: kind === 'orders' ? 'Teste: encomenda enviada' : 'Teste: stock baixo',
    body: 'Notificação de teste ao alerta real — se vês isto, este alerta vai chegar quando acontecer de verdade.',
    tag: 'test-notification'
  });

  const devices = [];
  for (const row of targets) {
    const subscription = {
      endpoint: row[COLS.ENDPOINT],
      keys: { p256dh: row[COLS.P256DH], auth: row[COLS.AUTH] }
    };
    const owner = recipients.find(u => u.id === row[COLS.USER_ID]);
    try {
      await webpush.sendNotification(subscription, payload);
      devices.push({ user: owner ? owner.name : row[COLS.USER_ID], userAgent: row[COLS.USER_AGENT] || '(desconhecido)', ok: true });
    } catch (err) {
      devices.push({
        user: owner ? owner.name : row[COLS.USER_ID],
        userAgent: row[COLS.USER_AGENT] || '(desconhecido)',
        ok: false,
        error: err.body || err.message,
        statusCode: err.statusCode || null
      });
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscriptionByEndpoint(subscription.endpoint).catch(() => {});
      }
    }
  }

  return {
    ok: devices.some(d => d.ok),
    recipients: recipients.map(u => u.name),
    recipientsWithoutDevice: recipientsWithoutDevice.map(u => u.name),
    devices
  };
}

module.exports = {
  ensureVapid,
  ensureSubsTab,
  saveSubscription,
  removeSubscriptionByEndpoint,
  sendPushToUsers,
  sendTestPush,
  sendTestPushByKind
};
