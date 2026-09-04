// api/camera-ptz.js
//
// POST /api/camera-ptz { direction: 'up'|'down'|'left'|'right'|'stop' }
//
// Proxies pan/tilt commands to the camera's ONVIF (Profile S) service.
// The browser can't reach the camera directly — it's on Ricardo's home
// network — so this runs server-side, through the port-forwarded ONVIF
// port on the router (same pattern as the RTSP feed).

const { move } = require('../lib/onvif-ptz');

const HOST = process.env.CAMERA_ONVIF_HOST;
const PORT = process.env.CAMERA_ONVIF_PORT;
const USERNAME = process.env.CAMERA_ONVIF_USERNAME;
const PASSWORD = process.env.CAMERA_ONVIF_PASSWORD;

const VALID_DIRECTIONS = ['up', 'down', 'left', 'right', 'stop'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!HOST || !PORT || !USERNAME || !PASSWORD) {
    res.status(500).json({ error: 'Configuração da câmara em falta (variáveis CAMERA_ONVIF_*).' });
    return;
  }

  const { direction } = req.body || {};
  if (!VALID_DIRECTIONS.includes(direction)) {
    res.status(400).json({ error: `Direção inválida: ${direction}` });
    return;
  }

  try {
    await move({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD }, direction);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Falha ao mover a câmara' });
  }
};
