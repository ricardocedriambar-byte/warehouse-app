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

function ensureVapid() {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
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

module.exports = {
  ensureVapid,
  ensureSubsTab,
  saveSubscription,
  removeSubscriptionByEndpoint,
  sendPushToUsers
};
