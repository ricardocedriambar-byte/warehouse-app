// api/push.js
//
// Everything Web Push needs, in one file instead of three
// (vapid-public-key.js, push-subscribe.js, push-unsubscribe.js). Vercel's
// Hobby plan caps a deployment at 12 Serverless Functions — this app's
// api/ folder was already at 11 before Web Push, so three more files broke
// deployment ("No more than 12 Serverless Functions..."). Merging these
// three (they're all tiny, no shared logic beyond lib/push.js) buys back
// two of them.
//
//   GET    /api/push  -> { publicKey }              hands the frontend the
//                         VAPID public key it needs to create a subscription
//   POST   /api/push  -> { userId, subscription }   saves/updates a device's
//                         push subscription
//   DELETE /api/push  -> { endpoint }                removes a device's
//                         subscription (e.g. notifications turned off)

const { saveSubscription, removeSubscriptionByEndpoint } = require('../lib/push');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    if (!publicKey) {
      res.status(500).json({ error: 'VAPID_PUBLIC_KEY não está configurada no servidor' });
      return;
    }
    res.status(200).json({ publicKey });
    return;
  }

  if (req.method === 'POST') {
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
    return;
  }

  if (req.method === 'DELETE') {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint é obrigatório' });
      return;
    }
    try {
      await removeSubscriptionByEndpoint(endpoint);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('push-unsubscribe failed:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
