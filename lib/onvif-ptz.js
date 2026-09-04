// lib/onvif-ptz.js
//
// Minimal ONVIF (Profile S) PTZ client — just enough to discover the
// camera's PTZ/Media service addresses and issue ContinuousMove/Stop.
// Tapo cameras don't expose their pan/tilt motors through any open API
// except ONVIF, so this is the only non-reverse-engineered way to do it.
// No external dependencies: built-in fetch + crypto only.

const crypto = require('crypto');

function buildSecurityHeader(username, password) {
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
    .digest('base64');

  return `
    <Security xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <UsernameToken>
        <Username>${username}</Username>
        <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
        <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>
        <wsu:Created>${created}</wsu:Created>
      </UsernameToken>
    </Security>`;
}

function envelope(body, security) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Header>${security}</s:Header>
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

async function soapRequest(url, body, security) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: envelope(body, security),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Pedido ONVIF falhou (${res.status}): ${text.slice(0, 300)}`);
  }
  return text;
}

function extractServiceXAddr(capsXml, service) {
  const match = capsXml.match(
    new RegExp(`<[^:>]*:?${service}>[\\s\\S]*?<[^:>]*:?XAddr>([^<]*)<\\/[^:>]*:?XAddr>`, 'i')
  );
  return match ? match[1] : null;
}

function extractProfileToken(profilesXml) {
  const match = profilesXml.match(/<[^:>]*:?Profiles[^>]*\btoken="([^"]*)"/i);
  return match ? match[1] : null;
}

// Discovers the camera's PTZ/Media service addresses and the first media
// profile's token — everything ContinuousMove/Stop need. Done fresh on
// every call since serverless functions don't keep state between requests.
async function discover({ host, port, username, password }) {
  const deviceUrl = `http://${host}:${port}/onvif/device_service`;

  const capsXml = await soapRequest(
    deviceUrl,
    `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>`,
    buildSecurityHeader(username, password)
  );
  const ptzUrl = extractServiceXAddr(capsXml, 'PTZ');
  const mediaUrl = extractServiceXAddr(capsXml, 'Media');
  if (!ptzUrl || !mediaUrl) {
    throw new Error('A câmara não devolveu os endereços de PTZ/Media (confirma se suporta ONVIF Profile S).');
  }

  const profilesXml = await soapRequest(
    mediaUrl,
    `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`,
    buildSecurityHeader(username, password)
  );
  const profileToken = extractProfileToken(profilesXml);
  if (!profileToken) {
    throw new Error('Não foi possível obter o perfil de vídeo da câmara.');
  }

  return { ptzUrl, profileToken };
}

const SPEED = 0.5;
const VECTORS = {
  up: { x: 0, y: SPEED },
  down: { x: 0, y: -SPEED },
  left: { x: -SPEED, y: 0 },
  right: { x: SPEED, y: 0 },
};

async function move(creds, direction) {
  const { ptzUrl, profileToken } = await discover(creds);
  const security = buildSecurityHeader(creds.username, creds.password);

  if (direction === 'stop') {
    await soapRequest(
      ptzUrl,
      `<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl">
        <ProfileToken>${profileToken}</ProfileToken>
        <PanTilt>true</PanTilt>
        <Zoom>true</Zoom>
      </Stop>`,
      security
    );
    return;
  }

  const vector = VECTORS[direction];
  if (!vector) throw new Error(`Direção desconhecida: ${direction}`);

  await soapRequest(
    ptzUrl,
    `<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl">
      <ProfileToken>${profileToken}</ProfileToken>
      <Velocity>
        <PanTilt x="${vector.x}" y="${vector.y}" xmlns="http://www.onvif.org/ver10/schema"/>
      </Velocity>
    </ContinuousMove>`,
    security
  );
}

module.exports = { move };
