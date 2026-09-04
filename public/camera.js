// camera.js — Câmara (leitor de vídeo nativo, ligado diretamente ao go2rtc)
//
// Em vez de mostrar a interface do Frigate/go2rtc num iframe, isto fala
// diretamente com a API do go2rtc usando WebRTC "puro" — o browser
// liga-se por WebSocket para negociar a ligação, e o vídeo chega por
// WebRTC como qualquer chamada de vídeo. O resultado é um leitor com a
// cara da própria app, sem nada emprestado.
//
// Protocolo do go2rtc (estável, é o mesmo que o próprio interface web
// dele usa): abre um WebSocket para /api/ws?src=<nome>, troca uma
// oferta/resposta SDP e candidatos ICE em mensagens JSON simples.
//
// O PTZ (mover a câmara) usa ONVIF, através de /api/camera-ptz — a Tapo
// não tem nenhuma API aberta própria para isto, ONVIF é a única forma
// não-invertida de o fazer, e mesmo essa só o backend consegue falar
// (a câmara está na rede de casa, não é alcançável pelo browser).

const CAMERA_API_HOST = 'api-frigate.aknz9s.easypanel.host';
const CAMERA_STREAM_NAME = 'traseira';
// Must match the ice_servers entry in go2rtc.yaml exactly — both ends of
// a WebRTC connection negotiate independently, so the browser needs its
// own copy of the TURN credentials, not just go2rtc.
const CAMERA_TURN_HOST = '51.170.37.143:3478';
const CAMERA_TURN_USERNAME = 'camuser';
const CAMERA_TURN_CREDENTIAL = 'umapasswordforte123';

let cameraPc = null;
let cameraWs = null;
let cameraRendered = false;

function renderCameraPanel() {
  const root = document.getElementById('camera-panel');
  if (!root) return;

  if (!cameraRendered) {
    root.innerHTML = `
      <div class="camera-view">
        <div class="camera-view__header">
          <span class="camera-view__title">Câmara — Traseira</span>
          <span class="camera-view__status" id="camera-status">
            <span class="camera-view__dot" id="camera-dot"></span>
            <span id="camera-status-text">A ligar…</span>
          </span>
        </div>
        <div class="camera-view__frame">
          <video id="camera-video" class="camera-view__video" autoplay playsinline muted></video>
          <div class="camera-view__overlay" id="camera-overlay">
            <div class="camera-view__spinner" aria-hidden="true"></div>
            <span id="camera-overlay-text">A ligar à câmara…</span>
            <button class="btn-ghost" id="camera-retry-btn" style="display:none">Tentar novamente</button>
          </div>
        </div>
        <div class="camera-ptz" id="camera-ptz">
          <button class="camera-ptz__btn camera-ptz__btn--up" data-dir="up" aria-label="Mover para cima">
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5l7 7-1.4 1.4L13 8.8V19h-2V8.8l-4.6 4.6L5 12z" fill="currentColor"/></svg>
          </button>
          <button class="camera-ptz__btn camera-ptz__btn--left" data-dir="left" aria-label="Mover para a esquerda">
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M19 12l-7 7-1.4-1.4L15.2 13H5v-2h10.2l-4.6-4.6L12 5z" fill="currentColor"/></svg>
          </button>
          <button class="camera-ptz__btn camera-ptz__btn--right" data-dir="right" aria-label="Mover para a direita">
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 12l7-7 1.4 1.4L8.8 11H19v2H8.8l4.6 4.6L12 19z" fill="currentColor"/></svg>
          </button>
          <button class="camera-ptz__btn camera-ptz__btn--down" data-dir="down" aria-label="Mover para baixo">
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 19l-7-7 1.4-1.4L11 15.2V5h2v10.2l4.6-4.6L19 12z" fill="currentColor"/></svg>
          </button>
        </div>
      </div>
    `;
    document.getElementById('camera-retry-btn').addEventListener('click', startCameraStream);
    wireCameraPtz();
    cameraRendered = true;
  }

  startCameraStream();
}

function stopCameraPanel() {
  if (cameraWs) { try { cameraWs.close(); } catch {} cameraWs = null; }
  if (cameraPc) { try { cameraPc.close(); } catch {} cameraPc = null; }
  setCameraStatus('idle', '');
}

function setCameraStatus(state, text) {
  const dot = document.getElementById('camera-dot');
  const statusText = document.getElementById('camera-status-text');
  const overlay = document.getElementById('camera-overlay');
  const overlayText = document.getElementById('camera-overlay-text');
  const retryBtn = document.getElementById('camera-retry-btn');
  if (!dot) return;

  dot.dataset.state = state;
  if (statusText) statusText.textContent = text;

  if (state === 'live') {
    overlay.style.display = 'none';
  } else {
    overlay.style.display = 'flex';
    if (overlayText) overlayText.textContent = text;
    if (retryBtn) retryBtn.style.display = state === 'error' ? '' : 'none';
  }
}

function startCameraStream() {
  stopCameraPanel();
  setCameraStatus('connecting', 'A ligar à câmara…');

  const video = document.getElementById('camera-video');
  if (!video) return;

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: `turn:${CAMERA_TURN_HOST}`, username: CAMERA_TURN_USERNAME, credential: CAMERA_TURN_CREDENTIAL }
    ]
  });
  cameraPc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (ev) => {
    video.srcObject = ev.streams[0];
    // The overlay's own spinner stays up until the video actually starts
    // playing (not just until the track arrives) — onplaying fires once
    // real frames are being decoded, which is the honest "it's live" signal.
    video.play().catch(err => console.error('[camera] play() falhou', err));
  };
  video.onplaying = () => setCameraStatus('live', 'Ao vivo');

  // Console-only diagnostics — check these in the browser devtools if the
  // picture stays black: iceConnectionState tells us whether real media
  // packets are actually negotiated (not just the signaling handshake).
  pc.oniceconnectionstatechange = () => {
    console.log('[camera] iceConnectionState:', pc.iceConnectionState);
  };
  pc.onconnectionstatechange = () => {
    console.log('[camera] connectionState:', pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setCameraStatus('error', 'A ligação caiu. Tenta outra vez.');
    }
  };

  const wsUrl = `wss://${CAMERA_API_HOST}/api/ws?src=${encodeURIComponent(CAMERA_STREAM_NAME)}`;
  const ws = new WebSocket(wsUrl);
  cameraWs = ws;

  pc.onicecandidate = (ev) => {
    if (ev.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webrtc/candidate', value: ev.candidate.candidate }));
    }
  };

  ws.onopen = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'webrtc/offer', value: offer.sdp }));
    } catch (err) {
      console.error('Falha ao criar oferta WebRTC', err);
      setCameraStatus('error', 'Não foi possível ligar à câmara.');
    }
  };

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'webrtc/answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.value });
      } else if (msg.type === 'webrtc/candidate') {
        await pc.addIceCandidate({ candidate: msg.value, sdpMid: '0', sdpMLineIndex: 0 });
      }
    } catch (err) {
      console.error('Erro na negociação WebRTC', err);
    }
  };

  ws.onerror = () => setCameraStatus('error', 'Não foi possível ligar à câmara.');
  // go2rtc closes the signaling WebSocket right after negotiation
  // finishes — that's expected, not a failure, so this only reports an
  // error if the peer connection never got anywhere at all (still 'new').
  ws.onclose = () => {
    if (cameraPc && (cameraPc.connectionState === 'new' || cameraPc.connectionState === 'failed')) {
      setCameraStatus('error', 'Não foi possível ligar à câmara.');
    }
  };
}

// PTZ (pan/tilt) — press-and-hold buttons: send the direction on press,
// send "stop" on release, matching ONVIF's ContinuousMove/Stop model.
function wireCameraPtz() {
  const ptz = document.getElementById('camera-ptz');
  if (!ptz) return;

  ptz.querySelectorAll('[data-dir]').forEach(btn => {
    const dir = btn.dataset.dir;
    const start = (e) => { e.preventDefault(); sendPtz(dir); };
    const stop = () => sendPtz('stop');
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  });
}

function sendPtz(direction) {
  fetch('/api/camera-ptz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  }).catch(err => console.error('[camera] PTZ falhou', err));
}
