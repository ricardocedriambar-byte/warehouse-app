// camera.js — Câmara (leitor de vídeo nativo, ligado diretamente ao go2rtc)
//
// Em vez de mostrar a interface do Frigate num iframe, isto fala
// diretamente com a API do go2rtc (o motor de streaming que já vem
// dentro do Frigate) usando WebRTC "puro" — o browser liga-se por
// WebSocket para negociar a ligação, e o vídeo chega por WebRTC como
// qualquer chamada de vídeo. O resultado é um leitor com a cara da
// própria app, sem nada emprestado.
//
// Protocolo do go2rtc (estável, é o mesmo que o próprio interface web
// dele usa): abre um WebSocket para /api/ws?src=<nome>, troca uma
// oferta/resposta SDP e candidatos ICE em mensagens JSON simples.

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
            <span id="camera-overlay-text">A ligar à câmara…</span>
            <button class="btn-ghost" id="camera-retry-btn" style="display:none">Tentar novamente</button>
            <button class="btn-ghost" id="camera-tap-btn" style="display:none">Toca para reproduzir</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('camera-retry-btn').addEventListener('click', startCameraStream);
    document.getElementById('camera-tap-btn').addEventListener('click', () => {
      document.getElementById('camera-video').play().then(() => setCameraStatus('live', 'Ao vivo'));
    });
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
  const tapBtn = document.getElementById('camera-tap-btn');
  if (!dot) return;

  dot.dataset.state = state === 'tap' ? 'connecting' : state;
  if (statusText) statusText.textContent = text;

  if (state === 'live') {
    overlay.style.display = 'none';
  } else {
    overlay.style.display = 'flex';
    if (overlayText) overlayText.textContent = text;
    if (retryBtn) retryBtn.style.display = state === 'error' ? '' : 'none';
    if (tapBtn) tapBtn.style.display = state === 'tap' ? '' : 'none';
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
    setCameraStatus('live', 'Ao vivo');
    // Autoplay can silently fail on some mobile browsers even when muted —
    // force it, and fall back to a tap-to-play prompt if it's rejected.
    video.play().catch(() => setCameraStatus('tap', 'Toca para reproduzir'));
  };

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
