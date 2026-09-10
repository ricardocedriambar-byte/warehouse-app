// resources.js — Recursos (tabelas de preços e catálogos de fornecedores)
//
// Read-only tab: the PDFs themselves live in Google Drive, auto-discovered
// from the folder structure (see lib/resources.js). Two-level view: a
// compact clickable list of fornecedores, then that fornecedor's documents.
// Vendedor-only — wired in app.js / hidden via applyRoleRestrictions().

let resourcesRendered = false;
let resourcesGroups = null; // Map<fornecedor, item[]>, filled once on first load
let resourcesLogoOverrides = {}; // { fornecedor: url }, from the LogosFornecedores sheet tab

async function renderResourcesPanel() {
  const root = document.getElementById('recursos-panel');
  if (!root) return;

  // Build the shell (header + list container) only the first time — but
  // always re-fetch below. Previously this whole function short-circuited
  // after the first render (resourcesRendered), so a PDF added to Drive,
  // or a supplier folder renamed, never showed up until the app was fully
  // closed and reopened. Re-fetching on every visit to the tab fixes that,
  // matching how Encomendas/Inventário already reload each time you open
  // them instead of only once per page load.
  if (!resourcesRendered) {
    resourcesRendered = true;
    root.innerHTML = `
      <div class="resources-view">
        <div class="resources-view__header" id="resources-header">
          <h2 class="resources-view__title">Recursos</h2>
        </div>
        <div id="resources-list" class="resources-list">
          <div class="resources__loading">A carregar recursos…</div>
        </div>
      </div>
    `;
  }

  await loadResources();
}

function resEsc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function loadResources() {
  const list = document.getElementById('resources-list');
  if (!list) return;

  try {
    const res = await fetch('/api/resources');
    const data = await res.json();
    const items = data.resources || [];

    if (!items.length) {
      list.innerHTML = `<div class="resources__empty">Ainda não há recursos. Adiciona PDFs às pastas dos fornecedores no Drive.</div>`;
      return;
    }

    resourcesGroups = new Map();
    for (const item of items) {
      if (!resourcesGroups.has(item.fornecedor)) resourcesGroups.set(item.fornecedor, []);
      resourcesGroups.get(item.fornecedor).push(item);
    }
    resourcesLogoOverrides = data.logos || {};

    renderFornecedoresList();
  } catch (err) {
    console.error('Falha ao carregar recursos', err);
    list.innerHTML = `<div class="resources__empty" style="color:var(--danger)">Não foi possível carregar os recursos.</div>`;
  }
}

function renderFornecedoresList() {
  const header = document.getElementById('resources-header');
  const list = document.getElementById('resources-list');
  if (!header || !list) return;

  header.innerHTML = `<h2 class="resources-view__title">Recursos</h2>`;

  const fornecedores = Array.from(resourcesGroups.keys()).sort((a, b) => a.localeCompare(b, 'pt'));

  list.innerHTML = fornecedores.map(fornecedor => `
    <button class="resources-supplier-row" data-fornecedor="${resEsc(fornecedor)}">
      <span class="resources-supplier-row__icon" data-icon-for="${resEsc(fornecedor)}">🏭</span>
      <span class="resources-supplier-row__nome">${resEsc(fornecedor)}</span>
      <span class="resources-supplier-row__count">${resourcesGroups.get(fornecedor).length}</span>
      <span class="resources-supplier-row__chevron">›</span>
    </button>
  `).join('');

  list.querySelectorAll('.resources-supplier-row').forEach(btn => {
    btn.addEventListener('click', () => renderFornecedorDocs(btn.dataset.fornecedor));
  });

  fornecedores.forEach(applyFornecedorLogo);
}

// Best-effort: looks up the supplier's domain by name via Clearbit's free
// Autocomplete API, then uses Google's favicon service to grab an icon for
// that domain — both public, no API key. Falls back to the 🏭 emoji when
// no match is found or either request fails. Results are cached in memory
// so switching back to this list doesn't re-fetch.
const resourcesLogoCache = new Map(); // fornecedor -> domain | null

async function resolveFornecedorDomain(fornecedor) {
  if (resourcesLogoCache.has(fornecedor)) return resourcesLogoCache.get(fornecedor);
  try {
    const res = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(fornecedor)}`);
    if (!res.ok) throw new Error('lookup failed');
    const matches = await res.json();
    const domain = matches?.[0]?.domain || null;
    resourcesLogoCache.set(fornecedor, domain);
    return domain;
  } catch {
    resourcesLogoCache.set(fornecedor, null);
    return null;
  }
}

async function applyFornecedorLogo(fornecedor) {
  const override = resourcesLogoOverrides[fornecedor];
  if (override) {
    setFornecedorIcon(fornecedor, override);
    return;
  }

  const domain = await resolveFornecedorDomain(fornecedor);
  if (!domain) return;
  setFornecedorIcon(fornecedor, `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`);
}

function setFornecedorIcon(fornecedor, src) {
  const img = new Image();
  img.className = 'resources-supplier-row__logo';
  img.alt = '';
  img.src = src;
  img.onload = () => {
    // The icon element may have been re-rendered (e.g. list re-sorted) by
    // the time this resolves — always re-query rather than holding a stale ref.
    const icon = document.querySelector(`.resources-supplier-row__icon[data-icon-for="${CSS.escape(fornecedor)}"]`);
    if (icon) icon.replaceChildren(img);
  };
  // onerror: leave the emoji fallback in place.
}

function renderFornecedorDocs(fornecedor) {
  const header = document.getElementById('resources-header');
  const list = document.getElementById('resources-list');
  if (!header || !list) return;

  header.innerHTML = `
    <button class="resources-back-btn" id="resources-back-btn" aria-label="Voltar">‹ Fornecedores</button>
    <h2 class="resources-view__title">${resEsc(fornecedor)}</h2>
  `;
  document.getElementById('resources-back-btn').addEventListener('click', renderFornecedoresList);

  const docs = resourcesGroups.get(fornecedor) || [];

  list.innerHTML = docs.map(item => `
    <button class="resources-row" data-url="${resEsc(item.url)}" data-nome="${resEsc(item.nome)}" data-file-id="${resEsc(item.fileId || '')}">
      <span class="resources-row__icon">📄</span>
      <span class="resources-row__main">
        <span class="resources-row__nome">${resEsc(item.nome)}</span>
        ${item.tipo || item.atualizado ? `
          <span class="resources-row__meta">
            ${item.tipo ? resEsc(item.tipo) : ''}${item.tipo && item.atualizado ? ' · ' : ''}${item.atualizado ? resEsc(item.atualizado) : ''}
          </span>` : ''}
      </span>
    </button>
  `).join('');

  list.querySelectorAll('.resources-row').forEach(btn => {
    btn.addEventListener('click', () => openResourceViewer(btn.dataset.url, btn.dataset.nome, btn.dataset.fileId));
  });
}

// Opens the PDF in an in-app iframe overlay rather than navigating out
// to drive.google.com — on mobile, top-level navigation to a Drive link
// gets intercepted by the Drive app and forces a Google sign-in prompt.
// An iframe embed never triggers that handoff, and since Google serves
// the bytes directly (not through our own API), there's no file-size
// limit either.
//
// Drive's own /preview embed doesn't expose enough zoom to comfortably
// read small print on a phone, and it has no share option at all — both
// are handled ourselves here instead: a pinch/double-tap/button zoom on
// the embedded frame (see attachZoomPan), and a "Partilhar" button that
// hands Drive's normal /view link to the device's native share sheet.
function openResourceViewer(url, nome, fileId) {
  const root = document.getElementById('recursos-panel');
  if (!root) return;

  const overlay = document.createElement('div');
  overlay.className = 'resources-viewer';
  overlay.innerHTML = `
    <div class="resources-viewer__header">
      <span class="resources-viewer__title">${resEsc(nome)}</span>
      <div class="resources-viewer__actions">
        ${fileId ? `<button class="resources-viewer__share" aria-label="Partilhar">🔗</button>` : ''}
        <button class="resources-viewer__close" aria-label="Fechar">✕</button>
      </div>
    </div>
    <div class="resources-viewer__stage" id="resources-viewer-stage">
      <iframe class="resources-viewer__frame" id="resources-viewer-frame" src="${resEsc(url)}" allow="autoplay" allowfullscreen></iframe>
    </div>
    <div class="resources-viewer__zoom-controls">
      <button class="resources-viewer__zoom-btn" data-zoom="out" aria-label="Reduzir zoom">−</button>
      <button class="resources-viewer__zoom-btn resources-viewer__zoom-btn--reset" data-zoom="reset">100%</button>
      <button class="resources-viewer__zoom-btn" data-zoom="in" aria-label="Aumentar zoom">+</button>
    </div>
  `;
  overlay.querySelector('.resources-viewer__close').addEventListener('click', () => overlay.remove());

  if (fileId) {
    overlay.querySelector('.resources-viewer__share').addEventListener('click', () => shareResource(fileId, nome));
  }

  const stage = overlay.querySelector('#resources-viewer-stage');
  const frame = overlay.querySelector('#resources-viewer-frame');
  const zoom = attachZoomPan(stage, frame);
  const zoomLabel = overlay.querySelector('.resources-viewer__zoom-btn--reset');
  overlay.querySelectorAll('.resources-viewer__zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.zoom === 'in') zoom.zoomIn();
      else if (btn.dataset.zoom === 'out') zoom.zoomOut();
      else zoom.reset();
    });
  });
  zoom.onChange(pct => { zoomLabel.textContent = `${pct}%`; });

  root.appendChild(overlay);
}

// Drive's PDF is rendered inside a cross-origin iframe, so we can't reach
// into its own viewer to add zoom — instead this scales/pans the iframe
// element itself (a CSS transform on our side of the boundary), which
// works the same regardless of what Drive's embed does or doesn't expose:
// pinch with two fingers, double-tap to jump between 100%/250%, drag to
// pan once zoomed in, or use the +/−/100% buttons. While zoomed in the
// iframe's own pointer events are disabled so our drag-to-pan isn't
// fighting the PDF viewer underneath; at 100% it's handed back so Drive's
// own scrolling/controls work normally.
function attachZoomPan(stage, frame) {
  const MIN = 1, MAX = 4, STEP = 0.6;
  let scale = 1, panX = 0, panY = 0;
  const pointers = new Map();
  let pinchStartDist = 0, pinchStartScale = 1;
  let dragStart = null;
  let onChangeCb = null;

  function apply() {
    frame.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    frame.style.pointerEvents = scale > 1.01 ? 'none' : 'auto';
    if (onChangeCb) onChangeCb(Math.round(scale * 100));
  }

  function clampPan() {
    const rect = stage.getBoundingClientRect();
    const maxX = Math.max(0, rect.width * scale - rect.width);
    const maxY = Math.max(0, rect.height * scale - rect.height);
    panX = Math.min(0, Math.max(-maxX, panX));
    panY = Math.min(0, Math.max(-maxY, panY));
  }

  // Keeps the point under (clientX, clientY) visually stationary while
  // the scale changes — otherwise zooming in always drifts toward the
  // top-left corner instead of the spot the user is actually looking at.
  function setZoom(newScale, clientX, clientY) {
    newScale = Math.min(MAX, Math.max(MIN, newScale));
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    panX = px - (px - panX) * (newScale / scale);
    panY = py - (py - panY) * (newScale / scale);
    scale = newScale;
    if (scale <= MIN) { scale = MIN; panX = 0; panY = 0; }
    clampPan();
    apply();
  }

  function stageCenter() {
    const rect = stage.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      pinchStartScale = scale;
      dragStart = null;
    } else if (pointers.size === 1 && scale > 1.01) {
      dragStart = { x: e.clientX - panX, y: e.clientY - panY };
    }
  });

  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      setZoom(pinchStartScale * (dist / pinchStartDist), mid.x, mid.y);
    } else if (pointers.size === 1 && dragStart && scale > 1.01) {
      panX = e.clientX - dragStart.x;
      panY = e.clientY - dragStart.y;
      clampPan();
      apply();
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStartDist = 0;
    if (pointers.size === 0) dragStart = null;
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  let lastTapAt = 0, lastTapPos = null;
  stage.addEventListener('pointerup', e => {
    if (pointers.size > 0) return;
    const now = Date.now();
    const closeToLastTap = lastTapPos && Math.hypot(e.clientX - lastTapPos.x, e.clientY - lastTapPos.y) < 30;
    if (now - lastTapAt < 350 && closeToLastTap) {
      setZoom(scale > 1.5 ? MIN : 2.5, e.clientX, e.clientY);
      lastTapAt = 0;
    } else {
      lastTapAt = now;
      lastTapPos = { x: e.clientX, y: e.clientY };
    }
  });

  return {
    zoomIn: () => { const c = stageCenter(); setZoom(scale + STEP, c.x, c.y); },
    zoomOut: () => { const c = stageCenter(); setZoom(scale - STEP, c.x, c.y); },
    reset: () => { scale = 1; panX = 0; panY = 0; apply(); },
    onChange: cb => { onChangeCb = cb; cb(100); }
  };
}

// Hands the file's normal Drive link to the device's native share sheet
// (WhatsApp, email, SMS, …) instead of the person needing to leave the
// app, find the file in Drive themselves, and use Drive's own share
// button. Falls back to copying the link when the Web Share API isn't
// available (most desktop browsers) or the person cancels/it fails.
async function shareResource(fileId, nome) {
  const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;

  if (navigator.share) {
    try {
      await navigator.share({ title: nome, url: viewUrl });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // person cancelled the share sheet
      console.error('share failed, falling back to clipboard', err);
    }
  }

  try {
    await navigator.clipboard.writeText(viewUrl);
    toast('Link copiado para a área de transferência', 'success');
  } catch (err) {
    console.error('clipboard write failed', err);
    toast('Não foi possível partilhar ou copiar o link', 'error');
  }
}
