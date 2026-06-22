// app.js — no build step, plain JS, runs directly in the browser.

const state = {
  items: [],
  itemsLoadedAt: 0,
  currentItem: null,
  stream: null,
  scanLoopId: null,
};

// ---------- small DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setView(name) {
  $$('.view').forEach((el) => el.dataset.active = String(el.dataset.view === name));
  $$('.tabbar__btn').forEach((el) => el.dataset.active = String(el.dataset.goto === name));
  if (name !== 'scan') stopScanner();
}

let toastTimer = null;
function toast(message, kind = 'default') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, 2600);
}

function setConnectionStatus(state, label) {
  const el = $('#connection-status');
  el.dataset.state = state;
  el.textContent = label;
}

// ---------- number formatting (PT style: comma decimal) ----------
function fmtNumber(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('pt-PT', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
function fmtCurrency(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ---------- data loading ----------
async function loadAllItems({ silent = false } = {}) {
  if (!silent) setConnectionStatus('loading', 'a atualizar…');
  try {
    const res = await fetch('/api/items');
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    state.items = data.items || [];
    state.itemsLoadedAt = Date.now();
    setConnectionStatus('ok', `${state.items.length} artigos`);
    return state.items;
  } catch (err) {
    console.error(err);
    setConnectionStatus('error', 'sem ligação');
    if (!silent) toast('Não foi possível atualizar os dados', 'error');
    return state.items;
  }
}

async function fetchItemBySku(sku) {
  const res = await fetch(`/api/items?sku=${encodeURIComponent(sku)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('lookup failed');
  const data = await res.json();
  return data.item;
}

// ---------- SKU normalization ----------
// QR text and SKU column match exactly in this sheet, but scans can
// pick up stray whitespace, so trim before lookup.
function normalizeSku(raw) {
  return String(raw || '').trim();
}

// ---------- item detail rendering ----------
function renderItemDetail(item) {
  const root = $('#item-detail');

  if (!item) {
    root.innerHTML = `
      <button class="back-btn" data-goto="scan">‹ Voltar a digitalizar</button>
      <div class="item-error">
        <p>Nenhum artigo encontrado para o código</p>
        <p class="item-error__sku">${state.lastFailedSku || ''}</p>
      </div>
    `;
    root.querySelector('[data-goto]').addEventListener('click', () => setView('scan'));
    return;
  }

  state.currentItem = item;
  const low = item.stock !== null && item.stock <= 0;

  root.innerHTML = `
    <button class="back-btn" data-goto="scan">‹ Voltar a digitalizar</button>

    <div class="item-card">
      <div class="item-card__sku">${item.sku}</div>
      <div class="item-card__title">${item.descricao || '(sem descrição)'}</div>
      <div class="item-card__family">${item.familia || ''}</div>
    </div>

    <div class="dims-strip">
      <div class="dims-strip__cell">
        <div class="dims-strip__value">${fmtNumber(item.comprimento, 0)}</div>
        <div class="dims-strip__label">Compr. mm</div>
      </div>
      <div class="dims-strip__cell">
        <div class="dims-strip__value">${fmtNumber(item.largura, 0)}</div>
        <div class="dims-strip__label">Largura mm</div>
      </div>
      <div class="dims-strip__cell">
        <div class="dims-strip__value">${fmtNumber(item.espessura, 0)}</div>
        <div class="dims-strip__label">Esp. mm</div>
      </div>
      <div class="dims-strip__cell">
        <div class="dims-strip__value">${fmtNumber(item.dimensaoM2, 3)}</div>
        <div class="dims-strip__label">m²/un.</div>
      </div>
    </div>

    <div class="field-cards">
      <div class="field-card" id="stock-card">
        <div class="field-card__top">
          <span class="field-card__label">Stock</span>
          <span class="field-card__current" data-low="${low}">${fmtNumber(item.stock, 3)}</span>
        </div>
        <div class="stepper">
          <button class="stepper__btn" data-step="-1" type="button">−</button>
          <input class="stepper__input" id="stock-input" type="number" step="any" value="${item.stock ?? 0}" inputmode="decimal" />
          <button class="stepper__btn" data-step="1" type="button">+</button>
        </div>
        <button class="field-card__save" id="stock-save" type="button">Guardar stock</button>
      </div>

      <div class="field-card" id="preco-card">
        <div class="field-card__top">
          <span class="field-card__label">Preço de venda</span>
          <span class="field-card__current">${fmtCurrency(item.preco)}</span>
        </div>
        <div class="stepper">
          <button class="stepper__btn" data-step="-0.5" type="button">−</button>
          <input class="stepper__input" id="preco-input" type="number" step="any" value="${item.preco ?? 0}" inputmode="decimal" />
          <button class="stepper__btn" data-step="0.5" type="button">+</button>
        </div>
        <button class="field-card__save" id="preco-save" type="button">Guardar preço</button>
      </div>
    </div>

    <div class="purchase-note">
      <span>Valor de compra: ${fmtCurrency(item.valorCompra)}</span>
      ${item.observacoes ? `<span>${item.observacoes}</span>` : ''}
    </div>
  `;

  root.querySelector('[data-goto]').addEventListener('click', () => setView('scan'));
  wireFieldCard(root, 'stock', item.stock, (val) => saveField('stock', val));
  wireFieldCard(root, 'preco', item.preco, (val) => saveField('preco', val));
}

function wireFieldCard(root, key, initialValue, onSave) {
  const card = root.querySelector(`#${key}-card`);
  const input = root.querySelector(`#${key}-input`);
  const saveBtn = root.querySelector(`#${key}-save`);

  const baseline = initialValue ?? 0; // empty cells start at 0 in the input
  const markDirty = () => {
    const dirty = parseFloat(input.value) !== baseline;
    saveBtn.dataset.dirty = String(dirty);
  };

  card.querySelectorAll('.stepper__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = parseFloat(btn.dataset.step);
      const current = parseFloat(input.value) || 0;
      const next = Math.round((current + delta) * 1000) / 1000;
      input.value = next;
      markDirty();
    });
  });

  input.addEventListener('input', markDirty);

  saveBtn.addEventListener('click', async () => {
    const value = parseFloat(input.value);
    if (Number.isNaN(value)) { toast('Valor inválido', 'error'); return; }
    saveBtn.textContent = 'A guardar…';
    await onSave(value);
  });
}

async function saveField(field, value) {
  const item = state.currentItem;
  if (!item) return;

  const body = { rowNumber: item.rowNumber, sku: item.sku };
  body[field === 'stock' ? 'stock' : 'preco'] = value;

  try {
    const res = await fetch('/api/update-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('save failed');
    const data = await res.json();

    state.currentItem = { ...state.currentItem, ...data.item };
    // Reflect the change in the in-memory list too, so Browse stays accurate
    // without a full refetch.
    const idx = state.items.findIndex((i) => i.sku === item.sku);
    if (idx !== -1) state.items[idx] = { ...state.items[idx], ...data.item };

    toast(field === 'stock' ? 'Stock atualizado' : 'Preço atualizado', 'success');
    renderItemDetail(state.currentItem);
  } catch (err) {
    console.error(err);
    toast('Falha ao guardar. Tente novamente.', 'error');
    const saveBtn = $(`#${field}-save`);
    if (saveBtn) saveBtn.textContent = field === 'stock' ? 'Guardar stock' : 'Guardar preço';
  }
}

// ---------- scan -> lookup flow ----------
async function handleScannedCode(rawValue) {
  stopScanner();
  const sku = normalizeSku(rawValue);
  setView('item');
  $('#item-detail').innerHTML = `<div class="item-error">A procurar ${sku}…</div>`;

  try {
    const item = await fetchItemBySku(sku);
    if (!item) state.lastFailedSku = sku;
    renderItemDetail(item);
  } catch (err) {
    console.error(err);
    state.lastFailedSku = sku;
    renderItemDetail(null);
  }
}

// ---------- camera scanning ----------
async function startScanner() {
  const stage = $('#scan-stage');
  const video = $('#scan-video');

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
  } catch (err) {
    console.error(err);
    toast('Sem acesso à câmara. Verifique as permissões.', 'error');
    return;
  }

  try {
    video.srcObject = state.stream;

    // Some browsers (notably Firefox on Android) can render a visibly live
    // <video> before videoWidth/videoHeight have actually settled, so wait
    // for loadedmetadata with a short timeout as a safety net.
    await new Promise((resolve) => {
      if (video.readyState >= 1 && video.videoWidth > 0) { resolve(); return; }
      video.addEventListener('loadedmetadata', resolve, { once: true });
      setTimeout(resolve, 1500);
    });

    await video.play();
    video.classList.add('live');
    stage.dataset.scanning = 'true';

    await ensureJsQR();
    scanLoopFallback(video);
  } catch (err) {
    console.error(err);
    toast('Erro ao iniciar leitor.', 'error');
  }
}

function stopScanner() {
  const stage = $('#scan-stage');
  const video = $('#scan-video');
  if (state.scanLoopId) {
    cancelAnimationFrame(state.scanLoopId);
    state.scanLoopId = null;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.classList.remove('live');
  video.srcObject = null;
  stage.dataset.scanning = 'false';
}

// Native BarcodeDetector is intentionally not used — see the note in
// startScanner() above for why jsQR is the scanner for all platforms.

// jsQR fallback for browsers without BarcodeDetector (notably Safari/iOS).
// The local copy (served by our own deployment) is tried first so scanning
// never depends on reaching an external CDN — some networks/browsers block
// or fail to reach specific CDNs (seen on Firefox Android with
// cdnjs.cloudflare.com). External CDNs are kept only as a last-resort
// fallback in case the local file is ever missing.
let jsQRLoaded = false;
const JSQR_SOURCES = [
  '/jsQR.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.js',
  'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js'
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`falhou: ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureJsQR() {
  if (jsQRLoaded || window.jsQR) { jsQRLoaded = true; return; }

  const errors = [];
  for (const src of JSQR_SOURCES) {
    try {
      await loadScript(src);
      if (window.jsQR) {
        jsQRLoaded = true;
        return;
      }
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error('Não foi possível carregar jsQR de nenhuma fonte: ' + errors.join('; '));
}

function scanLoopFallback(video) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Running jsQR on a full 1920x1080+ camera frame every animation frame is
  // far more pixel data than detection needs and can fall behind on
  // Android, making scanning feel unresponsive. Downscaling to a fixed
  // width keeps each frame's decode fast and consistent across devices.
  const TARGET_WIDTH = 480;

  const tick = () => {
    if (!state.stream) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
      const scale = TARGET_WIDTH / video.videoWidth;
      canvas.width = TARGET_WIDTH;
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height);

      if (code && code.data) {
        handleScannedCode(code.data);
        return;
      }
    }
    state.scanLoopId = requestAnimationFrame(tick);
  };
  state.scanLoopId = requestAnimationFrame(tick);
}

// ---------- browse / search ----------
function renderBrowseList(query) {
  const list = $('#browse-list');
  if (state.items.length === 0) {
    list.innerHTML = `<div class="browse__loading">A carregar artigos…</div>`;
    return;
  }

  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? state.items.filter((item) =>
        item.sku.toLowerCase().includes(q) ||
        item.descricao.toLowerCase().includes(q) ||
        item.familia.toLowerCase().includes(q)
      )
    : state.items;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="browse__empty">Nenhum artigo corresponde a "${query}"</div>`;
    return;
  }

  // Cap rendering for performance on very large sheets; search narrows it down.
  const shown = filtered.slice(0, 150);

  list.innerHTML = shown.map((item) => {
    const low = item.stock !== null && item.stock <= 0;
    return `
      <button class="browse-row" data-sku="${item.sku}">
        <div class="browse-row__main">
          <div class="browse-row__sku">${item.sku} · ${item.familia}</div>
          <div class="browse-row__desc">${item.descricao}</div>
          <div class="browse-row__dims">${fmtNumber(item.comprimento, 0)}×${fmtNumber(item.largura, 0)}×${fmtNumber(item.espessura, 0)}mm · ${fmtCurrency(item.preco)}</div>
        </div>
        <div>
          <span class="browse-row__stock-label">Stock</span>
          <span class="browse-row__stock" data-low="${low}">${fmtNumber(item.stock, 1)}</span>
        </div>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.browse-row').forEach((row) => {
    row.addEventListener('click', () => {
      const item = state.items.find((i) => i.sku === row.dataset.sku);
      setView('item');
      renderItemDetail(item);
    });
  });
}

// ---------- wiring ----------
function init() {
  $$('.tabbar__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setView(btn.dataset.goto);
      if (btn.dataset.goto === 'browse') renderBrowseList($('#browse-search').value);
    });
  });

  $('#scan-start-btn').addEventListener('click', startScanner);

  $('#manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#manual-sku');
    if (input.value.trim()) handleScannedCode(input.value.trim());
    input.value = '';
  });

  $('#browse-search').addEventListener('input', (e) => renderBrowseList(e.target.value));

  $('#refresh-btn').addEventListener('click', async () => {
    $('#refresh-btn').classList.add('spinning');
    await loadAllItems();
    renderBrowseList($('#browse-search').value);
    setTimeout(() => $('#refresh-btn').classList.remove('spinning'), 300);
  });

  loadAllItems();

  // Chrome PWA on Android has a built-in pull-to-refresh gesture that
  // CSS overscroll-behavior alone doesn't always block. This prevents it
  // by intercepting touchmove on the document when the active scrollable
  // view is already at the top — the exact condition that triggers the
  // Chrome PTR animation. Touches inside scrollable content are unaffected.
  document.addEventListener('touchmove', (e) => {
    const activeView = document.querySelector('.view[data-active="true"]');
    if (activeView && activeView.scrollTop === 0) {
      e.preventDefault();
    }
  }, { passive: false });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.error('SW registration failed', err));
  }
}

document.addEventListener('DOMContentLoaded', init);
