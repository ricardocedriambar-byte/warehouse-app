// viaturas.js — Viaturas (embed of Ricardo's self-hosted LubeLogger instance)
//
// Just an iframe pointing at the LubeLogger "garage" tab — LubeLogger
// itself handles everything (vehicles, maintenance, fuel logs). The
// iframe src is only set on first visit to this tab so it doesn't load
// on app startup.

const LUBELOGGER_URL = 'https://n8n-lubelogger.aknz9s.easypanel.host/Home?tab=garage';

let viaturasRendered = false;

function renderViaturasPanel() {
  const root = document.getElementById('viaturas-panel');
  if (!root) return;
  if (viaturasRendered) return;
  viaturasRendered = true;

  root.innerHTML = `<iframe class="viaturas-frame" src="${LUBELOGGER_URL}" title="Viaturas"></iframe>`;
}
