// api/push-subscribe.js
//
// POST /api/push-subscribe — stores (or updates) a device's push
// subscription against a user ID, so lib/push.js's sendPushToUsers() can
// reach it later. Called once per device the first time someone allows
// notifications, and again any time the browser rotates the subscription
// (PushManager can do this silently — the frontend listens for that and
// re-calls this endpoint).

const { saveSubscription } = require('../lib/push');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { userId, subscription } = req.body || {};
  if (!userId || !subscription || !subscription.endpoint) {
    res.status(400).json({ error: 'userId e subscription são obrigatórios' });
    return;
  }

  try {
    await saveSubscription(userId, subscription, req.headers['user-agent'] || '');
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('push-subscribe failed:', err);
    res.status(500).json({ error: err.message });
  }
};
