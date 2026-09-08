// api/vapid-public-key.js
//
// GET /api/vapid-public-key — hands the frontend the VAPID public key it
// needs to create a push subscription (PushManager.subscribe requires it
// as applicationServerKey). Safe to expose publicly — it's the public half
// of the key pair; only the private key (server-side only) can actually
// sign pushes.

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    res.status(500).json({ error: 'VAPID_PUBLIC_KEY não está configurada no servidor' });
    return;
  }
  res.status(200).json({ publicKey });
};
