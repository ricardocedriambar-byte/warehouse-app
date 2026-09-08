// api/push-unsubscribe.js
//
// POST /api/push-unsubscribe — removes a device's stored push
// subscription, e.g. when someone turns notifications off in Settings.

const { removeSubscriptionByEndpoint } = require('../lib/push');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

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
};
