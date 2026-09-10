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
    <button class="resources-row" data-nome="${resEsc(item.nome)}" data-file-id="${resEsc(item.fileId || '')}">
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
    btn.addEventListener('click', () => openResourceViewer(btn.dataset.fileId, btn.dataset.nome));
  });
}

// Opens the PDF rendered by our own viewer (pdf.js) instead of embedding
// Drive's /preview page. That embed always draws its own toolbar — page
// controls, a floating "Página / zoom / print" pill that can appear
// anywhere over the document, not just a fixed strip along one edge —
// and since it's a cross-origin iframe there is no way to reach into its
// DOM to hide any of it: cropping a fixed offset only worked as long as
// the unwanted UI stayed put along the top, and it doesn't. Rendering the
// PDF ourselves means there is no Drive UI to fight in the first place.
//
// The bytes come from our own /api/resources?fileId=... (a thin proxy to
// Drive's `files.get?alt=media`, see lib/resources.js) so the request
// stays same-origin — no CORS, no top-level navigation to drive.google.com
// that could trigger a Drive-app handoff or sign-in prompt on mobile.
async function openResourceViewer(fileId, nome) {
  const root = document.getElementById('recursos-panel');
  if (!root || !fileId) return;

  const overlay = document.createElement('div');
  overlay.className = 'resources-viewer';
  overlay.innerHTML = `
    <div class="resources-viewer__header">
      <span class="resources-viewer__title">${resEsc(nome)}</span>
      <div class="resources-viewer__actions">
        <button class="resources-viewer__share" aria-label="Partilhar">🔗</button>
        <button class="resources-viewer__close" aria-label="Fechar">✕</button>
      </div>
    </div>
    <div class="resources-viewer__scroll" id="resources-viewer-scroll">
      <div class="resources-viewer__pages" id="resources-viewer-pages"></div>
      <div class="resources-viewer__status" id="resources-viewer-status">A carregar documento…</div>
    </div>
    <div class="resources-viewer__zoom-controls">
      <button class="resources-viewer__zoom-btn" data-zoom="out" aria-label="Reduzir zoom">−</button>
      <button class="resources-viewer__zoom-btn resources-viewer__zoom-btn--reset" data-zoom="reset">100%</button>
      <button class="resources-viewer__zoom-btn" data-zoom="in" aria-label="Aumentar zoom">+</button>
    </div>
  `;

  let pdfViewer = null;
  const closeOverlay = () => { if (pdfViewer) pdfViewer.destroy(); overlay.remove(); };
  overlay.querySelector('.resources-viewer__close').addEventListener('click', closeOverlay);
  overlay.querySelector('.resources-viewer__share').addEventListener('click', () => shareResource(fileId, nome));

  root.appendChild(overlay);

  const scrollEl = overlay.querySelector('#resources-viewer-scroll');
  const pagesEl = overlay.querySelector('#resources-viewer-pages');
  const statusEl = overlay.querySelector('#resources-viewer-status');
  const zoomLabel = overlay.querySelector('.resources-viewer__zoom-btn--reset');

  try {
    pdfViewer = await createPdfCanvasViewer(scrollEl, pagesEl, `/api/resources?fileId=${encodeURIComponent(fileId)}`);
  } catch (err) {
    console.error('Falha ao abrir o PDF', err);
    statusEl.textContent = 'Não foi possível abrir este documento. Usa o botão de partilhar para o abrir noutro sítio.';
    statusEl.classList.add('resources-viewer__status--error');
    return;
  }
  statusEl.remove();

  overlay.querySelectorAll('.resources-viewer__zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.zoom === 'in') pdfViewer.zoomIn();
      else if (btn.dataset.zoom === 'out') pdfViewer.zoomOut();
      else pdfViewer.reset();
    });
  });
  pdfViewer.onChange(pct => { zoomLabel.textContent = `${pct}%`; });
  attachPdfPinchZoom(scrollEl, pagesEl, pdfViewer);
}

let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('/vendor/pdfjs/pdf.min.mjs').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsLibPromise;
}

// Renders the PDF at `url` into one <canvas> per page, stacked vertically
// inside `pagesEl` — `scrollEl` (a plain overflow:auto box) handles
// panning natively in both directions, so there's no manual drag-to-pan
// code to keep in sync with scroll position. "Zoom" here means
// re-rendering each page's canvas at a new resolution (crisp at any
// level) rather than CSS-scaling a fixed-resolution image; pinch gestures
// still get instant visual feedback via a temporary CSS transform (see
// attachPdfPinchZoom) while the real re-render happens once the gesture
// ends.
//
// Only page 1 (and whatever else is already on screen) is rendered up
// front — the rest are just sized as blank placeholders and rendered
// lazily via IntersectionObserver as they actually scroll into view.
// Multi-page catalogs used to render every single page before showing
// anything at all, which is a big part of why opening a longer document
// felt slow even though only the first page was ever visible at first.
async function createPdfCanvasViewer(scrollEl, pagesEl, url) {
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument(url);
  const pdf = await loadingTask.promise;

  const MIN = 0.5, MAX = 4, STEP = 0.5;
  let zoomLevel = 1;
  let fitScale = 1; // scale (CSS px per PDF point) that makes page 1 fill the viewer's width at zoomLevel 1
  const pageCache = new Map(); // pageNumber -> pdf.js Page
  const canvases = [];
  const renderTasks = new Map(); // pageNumber -> RenderTask
  const renderedAtLevel = new Map(); // pageNumber -> zoomLevel it was last actually painted at
  let onChangeCb = null;
  let destroyed = false;
  let observer = null;

  async function getPage(n) {
    if (!pageCache.has(n)) pageCache.set(n, await pdf.getPage(n));
    return pageCache.get(n);
  }

  function viewportFor(page, level) {
    const dpr = window.devicePixelRatio || 1;
    return { viewport: page.getViewport({ scale: fitScale * level * dpr }), dpr };
  }

  // Sizes a page's canvas box immediately without painting it — keeps
  // the scroll container's total height correct/stable right away so
  // later pages don't jump around as they get rendered lazily.
  async function sizePlaceholder(n) {
    const canvas = canvases[n - 1];
    const page = await getPage(n);
    const { viewport, dpr } = viewportFor(page, zoomLevel);
    canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`;
  }

  async function renderPageAt(n, level) {
    const canvas = canvases[n - 1];
    const page = await getPage(n);
    const { viewport, dpr } = viewportFor(page, level);
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`;

    const prevTask = renderTasks.get(n);
    if (prevTask) prevTask.cancel();

    const ctx = canvas.getContext('2d');
    const task = page.render({ canvasContext: ctx, viewport });
    renderTasks.set(n, task);
    try {
      await task.promise;
      renderedAtLevel.set(n, level);
    } catch (err) {
      if (err && err.name !== 'RenderingCancelledException') throw err;
    } finally {
      if (renderTasks.get(n) === task) renderTasks.delete(n);
    }
  }

  function renderIfStale(n, level) {
    if (renderedAtLevel.get(n) !== level) return renderPageAt(n, level);
    return Promise.resolve();
  }

  // First page decides the "100%" baseline: fills the visible width of
  // the scroll viewport, same as opening any document at fit-width.
  const firstPage = await getPage(1);
  const baseViewport = firstPage.getViewport({ scale: 1 });
  fitScale = Math.max(0.1, scrollEl.clientWidth / baseViewport.width);

  for (let i = 1; i <= pdf.numPages; i++) {
    const canvas = document.createElement('canvas');
    canvas.className = 'resources-viewer__page';
    canvas.dataset.page = i;
    pagesEl.appendChild(canvas);
    canvases.push(canvas);
  }

  // Page 1 renders for real (it's what's visible the instant the viewer
  // opens); everything else just gets sized so the layout/scrollbar is
  // correct, then renders on demand as it scrolls near the viewport.
  await renderPageAt(1, zoomLevel);
  await Promise.all(canvases.slice(1).map((_, i) => sizePlaceholder(i + 2)));
  if (onChangeCb) onChangeCb(Math.round(zoomLevel * 100));

  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        renderIfStale(Number(entry.target.dataset.page), zoomLevel);
      });
    }, { root: scrollEl, rootMargin: '600px 0px' });
    canvases.forEach(c => observer.observe(c));
  } else {
    // No IntersectionObserver (very old browser) — fall back to
    // rendering everything up front like before, rather than leaving
    // pages permanently blank.
    await Promise.all(canvases.slice(1).map((_, i) => renderPageAt(i + 2, zoomLevel)));
  }

  // Re-renders at `newLevel`, then adjusts scroll so the point under
  // (clientX, clientY) stays visually where it was — otherwise zooming
  // in always drifts toward the top-left corner of the page instead of
  // wherever the user was actually looking/pinching. Only pages already
  // near the viewport are actually repainted immediately; the rest are
  // just resized as placeholders and repaint lazily (same
  // IntersectionObserver) once they're scrolled to — keeps zooming fast
  // even on a long catalog instead of re-rendering every page every time.
  async function setZoomAtPoint(newLevel, clientX, clientY) {
    newLevel = Math.min(MAX, Math.max(MIN, newLevel));
    if (Math.abs(newLevel - zoomLevel) < 0.001) return;
    const rect = scrollEl.getBoundingClientRect();
    const contentX = scrollEl.scrollLeft + (clientX - rect.left);
    const contentY = scrollEl.scrollTop + (clientY - rect.top);
    const ratio = newLevel / zoomLevel;
    zoomLevel = newLevel;

    await Promise.all(canvases.map((canvas, i) => {
      const n = i + 1;
      const cRect = canvas.getBoundingClientRect();
      const nearViewport = cRect.bottom > rect.top - 600 && cRect.top < rect.bottom + 600;
      return nearViewport ? renderPageAt(n, zoomLevel) : sizePlaceholder(n);
    }));
    if (destroyed) return;
    scrollEl.scrollLeft = contentX * ratio - (clientX - rect.left);
    scrollEl.scrollTop = contentY * ratio - (clientY - rect.top);
    if (onChangeCb) onChangeCb(Math.round(zoomLevel * 100));
  }

  function viewerCenter() {
    const rect = scrollEl.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  return {
    zoomIn: () => { const c = viewerCenter(); setZoomAtPoint(zoomLevel + STEP, c.x, c.y); },
    zoomOut: () => { const c = viewerCenter(); setZoomAtPoint(zoomLevel - STEP, c.x, c.y); },
    reset: () => { const c = viewerCenter(); setZoomAtPoint(1, c.x, c.y); },
    setZoomAtPoint,
    get zoomLevel() { return zoomLevel; },
    get min() { return MIN; },
    get max() { return MAX; },
    onChange: cb => { onChangeCb = cb; },
    destroy: () => {
      destroyed = true;
      if (observer) observer.disconnect();
      renderTasks.forEach(t => t.cancel());
      loadingTask.destroy();
    }
  };
}

// pdf.js re-renders at a new resolution on every zoom step (see
// createPdfCanvasViewer), which is too slow to run continuously during a
// pinch gesture — instead this gives instant feedback with a plain CSS
// transform on the page stack while two fingers are down, then commits
// one real re-render (crisp, at the final size) once they lift. Native
// scrolling on `scrollEl` handles all panning, so there's nothing here
// but the pinch and the double-tap-to-toggle-zoom shortcut.
function attachPdfPinchZoom(scrollEl, pagesEl, viewer) {
  const pointers = new Map();
  let pinchStartDist = 0;
  let pinchOrigin = null; // { x, y } in pagesEl's own (untransformed) content coordinates

  function contentPoint(clientX, clientY) {
    const rect = scrollEl.getBoundingClientRect();
    return {
      x: scrollEl.scrollLeft + (clientX - rect.left),
      y: scrollEl.scrollTop + (clientY - rect.top)
    };
  }

  // Pointer capture is only taken once a second finger joins (i.e. once
  // this is actually a pinch) — capturing on every single touchstart used
  // to break native single-finger scrolling on some Android/Chrome builds
  // (the browser would stop handing off the pan gesture once the pointer
  // was captured), which is what made the page get "stuck" and unable to
  // scroll back up after reaching the bottom.
  scrollEl.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      pointers.forEach((_, id) => { try { scrollEl.setPointerCapture(id); } catch {} });
      const pts = [...pointers.values()];
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      pinchOrigin = contentPoint(mid.x, mid.y);
      pagesEl.style.transformOrigin = `${pinchOrigin.x}px ${pinchOrigin.y}px`;
    }
  });

  scrollEl.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchOrigin) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const liveRatio = Math.min(viewer.max / viewer.zoomLevel, Math.max(viewer.min / viewer.zoomLevel, dist / pinchStartDist));
      pagesEl.style.transform = `scale(${liveRatio})`;
    }
  });

  function endPinch(e) {
    const hadPinch = pointers.size === 2 && pinchOrigin;
    pointers.delete(e.pointerId);
    if (hadPinch && pointers.size < 2) {
      const transform = pagesEl.style.transform;
      pagesEl.style.transform = '';
      const m = /scale\(([\d.]+)\)/.exec(transform);
      const liveRatio = m ? parseFloat(m[1]) : 1;
      const rect = scrollEl.getBoundingClientRect();
      viewer.setZoomAtPoint(
        viewer.zoomLevel * liveRatio,
        pinchOrigin.x - scrollEl.scrollLeft + rect.left,
        pinchOrigin.y - scrollEl.scrollTop + rect.top
      );
      pinchOrigin = null;
      pinchStartDist = 0;
    }
  }
  scrollEl.addEventListener('pointerup', endPinch);
  scrollEl.addEventListener('pointercancel', endPinch);

  let lastTapAt = 0, lastTapPos = null;
  scrollEl.addEventListener('pointerup', e => {
    if (e.pointerType !== 'touch' || pointers.size > 0) return;
    const now = Date.now();
    const closeToLastTap = lastTapPos && Math.hypot(e.clientX - lastTapPos.x, e.clientY - lastTapPos.y) < 30;
    if (now - lastTapAt < 350 && closeToLastTap) {
      viewer.setZoomAtPoint(viewer.zoomLevel > 1.5 ? 1 : 2.5, e.clientX, e.clientY);
      lastTapAt = 0;
    } else {
      lastTapAt = now;
      lastTapPos = { x: e.clientX, y: e.clientY };
    }
  });
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
