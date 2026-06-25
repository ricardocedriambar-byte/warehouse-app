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
          <span class="field-card__current" data-low="${low}">
            ${fmtNumber(item.stock, 3)} un${item.unidade === 'm²' && item.dimensaoM2 && item.stock !== null ? ` · ${fmtNumber(item.stock * item.dimensaoM2, 2)} m²` : ''}
          </span>
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
          <span class="field-card__current">${fmtCurrency(item.preco)}${item.unidade ? `/${item.unidade}` : ''}</span>
        </div>
        ${!item.unidade ? `
          <div style="margin-bottom:10px">
            <div style="font-family:var(--font-mono);font-size:11px;color:var(--paper-dim);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Unidade de venda</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap" id="unidade-btns">
              ${['un', 'm²', 'ml', 'm³', 'lt'].map(u => `
                <button class="unidade-btn" data-unidade="${u}" type="button">${u}</button>
              `).join('')}
            </div>
          </div>
        ` : ''}
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

  // Unidade buttons only appear when unit isn't set yet — tap saves immediately
  root.querySelectorAll('.unidade-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const unit = btn.dataset.unidade;
      // Hide the whole unit selector row instantly
      const btnsWrap = root.querySelector('#unidade-btns')?.parentElement;
      if (btnsWrap) btnsWrap.style.display = 'none';
      // Update the price label to show the unit
      const precoLabel = root.querySelector('#preco-card .field-card__current');
      if (precoLabel) precoLabel.textContent = `${fmtCurrency(item.preco)}/${unit}`;
      // Save silently
      await saveField('unidade', unit);
    });
  });

  // Unidade wiring (legacy save button path — no longer rendered but kept for safety)
  const unidadeSaveBtn = root.querySelector('#unidade-save');
  if (unidadeSaveBtn) {
    unidadeSaveBtn.addEventListener('click', async () => {
      unidadeSaveBtn.textContent = 'A guardar…';
      await saveField('unidade', root.querySelector('.unidade-btn--active')?.dataset.unidade || '');
    });
  }
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
  if (field === 'stock') body.stock = value;
  else if (field === 'preco') body.preco = value;
  else if (field === 'unidade') body.unidade = value;

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

// ============================================================
// ORDER MANAGEMENT
// ============================================================

const orderState = {
  orders: [],
  clients: [],
  currentOrder: null,
  newOrderLines: [],     // lines being assembled for a new order
  newOrderClient: null,
  filterActive: true     // true = show active only, false = show all
};

// ---------- status helpers ----------
const STATUS_LABELS = {
  'Rascunho': { label: 'Rascunho', color: '' },
  'Enviado': { label: 'Enviado', color: 'Enviado' },
  'Em separação': { label: 'Em separação', color: 'Em separação' },
  'Concluído': { label: 'Concluído', color: 'Concluído' },
  'Cancelado': { label: 'Cancelado', color: '' }
};

function isActiveOrder(order) {
  return !['Concluído', 'Cancelado'].includes(order.status);
}

// ---------- API helpers ----------
async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `${path}: ${res.status}`);
  }
  return res.json();
}

async function apiPatch(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `${path}: ${res.status}`);
  }
  return res.json();
}

// ---------- load orders ----------
async function loadOrders({ silent = false } = {}) {
  try {
    const [ordersData, clientsData] = await Promise.all([
      apiGet('/api/orders'),
      apiGet('/api/clients')
    ]);
    orderState.orders = ordersData.orders || [];
    orderState.clients = clientsData.clients || [];
    return orderState.orders;
  } catch (err) {
    if (!silent) toast('Erro ao carregar encomendas', 'error');
    console.error(err);
    return [];
  }
}

// ---------- orders list ----------
function renderOrdersList() {
  const list = $('#orders-list');
  if (!list) return;

  const shown = orderState.filterActive
    ? orderState.orders.filter(isActiveOrder)
    : orderState.orders;

  if (shown.length === 0) {
    list.innerHTML = `<div class="orders-empty">${orderState.filterActive ? 'Sem encomendas ativas' : 'Sem encomendas'}</div>`;
    return;
  }

  // Sort: active first, then by date descending
  const sorted = [...shown].sort((a, b) => {
    if (isActiveOrder(a) !== isActiveOrder(b)) return isActiveOrder(a) ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  list.innerHTML = sorted.map(order => {
    const totalLines = order.lines.length;
    const pickedLines = order.lines.filter(l => l.qtyPicked >= l.qtyOrdered).length;
    const pct = totalLines > 0 ? Math.round((pickedLines / totalLines) * 100) : 0;
    const complete = pickedLines === totalLines && totalLines > 0;
    const date = order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-PT') : '';
    const statusInfo = STATUS_LABELS[order.status] || { label: order.status, color: '' };

    return `
      <button class="order-card" data-order-id="${order.orderId}">
        <div class="order-card__top">
          <span class="order-card__id">${order.orderId}</span>
          <span class="order-card__status" data-status="${order.status}">${statusInfo.label}</span>
        </div>
        <div class="order-card__client">${order.clientName || '—'}</div>
        <div class="order-card__meta">${totalLines} artigo${totalLines !== 1 ? 's' : ''} · ${date}${order.salesperson ? ' · ' + order.salesperson : ''}</div>
        <div class="order-card__progress">
          <div class="order-card__progress-bar" data-complete="${complete}" style="width:${pct}%"></div>
        </div>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.order-card').forEach(card => {
    card.addEventListener('click', () => openOrderDetail(card.dataset.orderId));
  });
}

async function openOrderDetail(orderId) {
  const order = orderState.orders.find(o => o.orderId === orderId);
  if (!order) return;
  orderState.currentOrder = order;

  if (order.status === 'Rascunho') {
    // Salesperson editing a draft or viewing it — go to pick/detail view
    renderOrderPick(order, true);
    setView('order-pick');
  } else {
    // Warehouse pick view
    renderOrderPick(order, false);
    setView('order-pick');
  }
}

// ---------- order create ----------
function renderOrderCreate() {
  orderState.newOrderLines = [];
  orderState.newOrderClient = null;

  const panel = $('#order-create-panel');
  if (!panel) return;

  panel.innerHTML = `
    <button class="back-btn" id="create-back-btn">‹ Encomendas</button>
    <div class="order-create">
      <div class="order-create__section">
        <div class="order-create__section-title">Cliente</div>
        <div class="client-search-wrap">
          <input class="order-field" id="client-search-input" type="text"
            placeholder="Pesquisar cliente…" autocomplete="off" style="margin:0" />
          <div class="client-search-results" id="client-search-results" style="display:none"></div>
          <div class="client-selected" id="client-selected" style="display:none"></div>
        </div>
        <div style="margin-top:8px">
          <button class="add-item-btn" id="new-client-btn" style="border-style:solid">
            + Novo cliente
          </button>
        </div>
      </div>

      <div class="order-create__section">
        <div class="order-create__section-title">Vendedor</div>
        <input class="order-field" id="salesperson-input" type="text" placeholder="Nome do vendedor" autocomplete="off" />
      </div>

      <div class="order-create__section">
        <div class="order-create__section-title">Artigos</div>
        <div class="order-lines" id="order-lines-list"></div>
        <button class="add-item-btn" id="add-item-btn">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          Adicionar artigo
        </button>
      </div>

      <div class="order-create__section">
        <div class="order-create__section-title">Notas</div>
        <textarea class="order-field" id="order-notes-input" rows="3" placeholder="Notas opcionais…" style="resize:none"></textarea>
      </div>

      <div class="order-actions">
        <button class="order-action-btn order-action-btn--draft" id="save-draft-btn">Guardar rascunho</button>
        <button class="order-action-btn order-action-btn--send" id="send-order-btn">Enviar para armazém</button>
      </div>
    </div>
  `;

  panel.querySelector('#create-back-btn').addEventListener('click', () => setView('orders'));
  panel.querySelector('#add-item-btn').addEventListener('click', () => showItemSearchOverlay());
  panel.querySelector('#new-client-btn').addEventListener('click', () => showNewClientForm());
  panel.querySelector('#save-draft-btn').addEventListener('click', () => submitOrder('Rascunho'));
  panel.querySelector('#send-order-btn').addEventListener('click', () => submitOrder('Enviado'));

  // Wire client search
  wireClientSearch(panel);
  renderOrderLines();
}

function wireClientSearch(root) {
  const input = root.querySelector('#client-search-input');
  const results = root.querySelector('#client-search-results');
  const selected = root.querySelector('#client-selected');

  function selectClient(client) {
    orderState.newOrderClient = client;
    input.style.display = 'none';
    results.style.display = 'none';
    selected.style.display = 'flex';
    selected.innerHTML = `
      <span style="flex:1;font-size:15px;font-weight:600">${client.name}</span>
      <button class="order-line-card__remove" id="clear-client-btn" type="button" style="font-size:14px;width:auto;padding:0 10px">Alterar</button>
    `;
    selected.querySelector('#clear-client-btn').addEventListener('click', () => {
      orderState.newOrderClient = null;
      input.style.display = '';
      input.value = '';
      selected.style.display = 'none';
      results.style.display = 'none';
      input.focus();
    });
  }

  function renderResults(q) {
    if (!q || q.length < 1) { results.style.display = 'none'; return; }
    const filtered = orderState.clients
      .filter(c => c.name.toLowerCase().includes(q.toLowerCase()) ||
                   c.id.toLowerCase().includes(q.toLowerCase()) ||
                   (c.phone && c.phone.includes(q)))
      .slice(0, 10);

    if (filtered.length === 0) {
      results.style.display = 'none';
      return;
    }

    results.style.display = 'block';
    results.innerHTML = filtered.map(c => `
      <button class="client-result-row" data-id="${c.id}" type="button">
        <span class="client-result-name">${c.name}</span>
        <span class="client-result-meta">${c.id}${c.phone ? ' · ' + c.phone : ''}</span>
      </button>
    `).join('');

    results.querySelectorAll('.client-result-row').forEach(row => {
      row.addEventListener('click', () => {
        const client = orderState.clients.find(c => c.id === row.dataset.id);
        if (client) selectClient(client);
      });
    });
  }

  input.addEventListener('input', e => renderResults(e.target.value));
  input.addEventListener('focus', e => renderResults(e.target.value));
  // Hide results when clicking outside
  document.addEventListener('click', e => {
    if (!root.querySelector('.client-search-wrap').contains(e.target)) {
      results.style.display = 'none';
    }
  }, { once: false });
}

function renderOrderLines() {
  const list = $('#order-lines-list');
  if (!list) return;

  if (orderState.newOrderLines.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = orderState.newOrderLines.map((line, idx) => {
    const total = (line.qtyOrdered || 0) * (line.unitPrice || 0);
    return `
    <div class="order-line-card" data-idx="${idx}">
      <div class="order-line-card__sku">${line.sku}</div>
      <div class="order-line-card__desc">${line.descricao}</div>
      <div class="order-line-card__dims">${fmtNumber(line.comprimento, 0)}×${fmtNumber(line.largura, 0)}×${fmtNumber(line.espessura, 0)}mm</div>
      <div class="order-line-card__inputs">
        <div style="flex:1;min-width:0">
          <input class="order-line-card__input" type="number" step="any" inputmode="decimal"
            value="${line.qtyOrdered}" data-field="qty" data-idx="${idx}" placeholder="Qty" />
          <div class="order-line-card__label">Qtd (${line.unidade || 'un'})</div>
        </div>
        <div style="flex:1;min-width:0">
          <input class="order-line-card__input" type="number" step="any" inputmode="decimal"
            value="${line.unitPrice}" data-field="price" data-idx="${idx}" placeholder="Preço" />
          <div class="order-line-card__label">€/${line.unidade || 'un'}</div>
        </div>
        <button class="order-line-card__remove" data-remove="${idx}" type="button">×</button>
      </div>
      <div class="order-line-card__total" data-idx="${idx}">Total: ${fmtCurrency(total)}</div>
    </div>
  `}).join('');

  list.querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx);
      const val = parseFloat(input.value) || 0;
      if (input.dataset.field === 'qty') orderState.newOrderLines[idx].qtyOrdered = val;
      if (input.dataset.field === 'price') orderState.newOrderLines[idx].unitPrice = val;
      // Update line total display live
      const line = orderState.newOrderLines[idx];
      const total = (line.qtyOrdered || 0) * (line.unitPrice || 0);
      const totalEl = list.querySelector(`.order-line-card__total[data-idx="${idx}"]`);
      if (totalEl) totalEl.textContent = `Total: ${fmtCurrency(total)}`;
    });
  });

  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.remove);
      orderState.newOrderLines.splice(idx, 1);
      renderOrderLines();
    });
  });
}

function showItemSearchOverlay() {
  // Make sure items are loaded before showing the overlay
  if (state.items.length === 0) {
    loadAllItems().then(() => showItemSearchOverlay());
    toast('A carregar artigos…', 'default');
    return;
  }

  const app = $('#app');
  const overlay = document.createElement('div');
  overlay.className = 'item-search-overlay';
  overlay.innerHTML = `
    <div class="item-search-overlay__header">
      <input class="item-search-overlay__input" id="item-search-input"
        type="text" placeholder="Pesquisar SKU ou descrição…" autocomplete="off" autofocus />
      <button class="item-search-overlay__cancel" id="item-search-cancel">Cancelar</button>
    </div>
    <div class="item-search-overlay__results" id="item-search-results"></div>
  `;
  app.appendChild(overlay);

  const searchInput = overlay.querySelector('#item-search-input');
  const results = overlay.querySelector('#item-search-results');

  overlay.querySelector('#item-search-cancel').addEventListener('click', () => overlay.remove());

  function renderResults(q) {
    const ql = (q || '').toLowerCase().trim();
    const filtered = ql
      ? state.items.filter(i =>
          i.sku.includes(ql) ||                          // exact SKU fragment
          i.sku.replace(/^0+/, '').includes(ql) ||        // SKU without leading zeros
          i.descricao.toLowerCase().includes(ql) ||
          i.familia.toLowerCase().includes(ql)
        ).slice(0, 60)
      : state.items.slice(0, 60);

    results.innerHTML = filtered.map(item => `
      <button class="browse-row" data-sku="${item.sku}" style="margin-bottom:8px">
        <div class="browse-row__main">
          <div class="browse-row__sku">${item.sku} · ${item.familia}</div>
          <div class="browse-row__desc">${item.descricao}</div>
          <div class="browse-row__dims">${fmtNumber(item.comprimento, 0)}×${fmtNumber(item.largura, 0)}×${fmtNumber(item.espessura, 0)}mm</div>
        </div>
        <div>
          <span class="browse-row__stock-label">Preço</span>
          <span class="browse-row__stock">${fmtCurrency(item.preco)}</span>
        </div>
      </button>
    `).join('');

    results.querySelectorAll('.browse-row').forEach(row => {
      row.addEventListener('click', () => {
        const item = state.items.find(i => i.sku === row.dataset.sku);
        if (!item) return;
        orderState.newOrderLines.push({
          sku: item.sku,
          descricao: item.descricao,
          comprimento: item.comprimento,
          largura: item.largura,
          espessura: item.espessura,
          unidade: item.unidade || 'un',
          qtyOrdered: 1,
          unitPrice: item.preco || 0
        });
        overlay.remove();
        renderOrderLines();
      });
    });
  }

  searchInput.addEventListener('input', e => renderResults(e.target.value));
  renderResults('');
  setTimeout(() => searchInput.focus(), 50);
}

function showNewClientForm() {
  const app = $('#app');
  const overlay = document.createElement('div');
  overlay.className = 'item-search-overlay';
  overlay.innerHTML = `
    <div class="item-search-overlay__header">
      <span style="font-weight:700;font-size:16px;flex:1">Novo cliente</span>
      <button class="item-search-overlay__cancel" id="client-form-cancel">Cancelar</button>
    </div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
      <input class="order-field" id="new-client-name" type="text" placeholder="Nome *" autocomplete="off" style="margin:0" />
      <input class="order-field" id="new-client-address" type="text" placeholder="Morada" autocomplete="off" style="margin:0" />
      <input class="order-field" id="new-client-phone" type="tel" placeholder="Telefone" autocomplete="off" style="margin:0" />
      <input class="order-field" id="new-client-email" type="email" placeholder="Email" autocomplete="off" style="margin:0" />
      <button class="order-action-btn order-action-btn--send" id="new-client-save">Guardar cliente</button>
    </div>
  `;
  $('#app').appendChild(overlay);

  overlay.querySelector('#client-form-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#new-client-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-client-name').value.trim();
    if (!name) { toast('Nome é obrigatório', 'error'); return; }
    try {
      const data = await apiPost('/api/clients', {
        name,
        address: overlay.querySelector('#new-client-address').value.trim(),
        phone: overlay.querySelector('#new-client-phone').value.trim(),
        email: overlay.querySelector('#new-client-email').value.trim()
      });
      orderState.clients.push(data.client);
      overlay.remove();
      // Re-render the create view so the new client appears in the dropdown
      renderOrderCreate();
      toast(`Cliente "${name}" criado`, 'success');
    } catch (err) {
      toast('Erro ao criar cliente', 'error');
    }
  });
}

async function submitOrder(targetStatus) {
  const client = orderState.newOrderClient;
  const salesperson = $('#salesperson-input')?.value.trim() || '';
  const orderNotes = $('#order-notes-input')?.value.trim() || '';

  if (!client) { toast('Selecione um cliente', 'error'); return; }
  if (orderState.newOrderLines.length === 0) { toast('Adicione pelo menos um artigo', 'error'); return; }

  const sendBtn = $('#send-order-btn');
  const draftBtn = $('#save-draft-btn');
  if (sendBtn) sendBtn.disabled = true;
  if (draftBtn) draftBtn.disabled = true;

  try {
    const data = await apiPost('/api/orders', {
      clientId: client.id, clientName: client.name, salesperson, orderNotes,
      lines: orderState.newOrderLines
    });

    // If target is Enviado, update status right away
    if (targetStatus === 'Enviado') {
      await apiPatch('/api/orders', { orderId: data.order.orderId, status: 'Enviado' });
    }

    await loadOrders({ silent: true });
    renderOrdersList();
    setView('orders');
    toast(targetStatus === 'Enviado' ? 'Encomenda enviada para armazém' : 'Rascunho guardado', 'success');
  } catch (err) {
    toast('Erro ao criar encomenda: ' + err.message, 'error');
    if (sendBtn) sendBtn.disabled = false;
    if (draftBtn) draftBtn.disabled = false;
  }
}

// ---------- order pick view ----------
function renderOrderPick(order, isDraft) {
  const panel = $('#order-pick-panel');
  if (!panel) return;

  const allPicked = order.lines.every(l => l.qtyPicked >= l.qtyOrdered);
  const pickedCount = order.lines.filter(l => l.qtyPicked >= l.qtyOrdered).length;

  panel.innerHTML = `
    <button class="back-btn" id="pick-back-btn">‹ Encomendas</button>
    <div class="order-pick">
      <div class="order-pick__header">
        <div class="order-pick__id">${order.orderId} · <span style="color:var(--paper-dim)">${order.status}</span></div>
        <div class="order-pick__client">${order.clientName}</div>
        ${order.orderNotes ? `<div style="font-size:13px;color:var(--paper-dim);margin-top:4px">${order.orderNotes}</div>` : ''}
        <div class="order-pick__progress-row">
          <span class="order-pick__progress-label">${pickedCount} de ${order.lines.length} separados</span>
          ${!isDraft && order.status === 'Enviado' ? `<button class="orders-filter-btn active" id="start-picking-btn">Iniciar separação</button>` : ''}
        </div>
      </div>

      ${isDraft ? `
        <div style="margin-bottom:16px;display:flex;gap:8px">
          <button class="order-action-btn order-action-btn--send" id="draft-send-btn" style="flex:2">
            Enviar para armazém
          </button>
          <button class="order-action-btn order-action-btn--draft" id="draft-cancel-btn" style="flex:1">
            Cancelar
          </button>
        </div>
      ` : ''}

      <div class="pick-lines">
        ${order.lines.map(line => {
          const done = line.qtyPicked >= line.qtyOrdered;
          return `
            <div class="pick-line" data-sku="${line.sku}" data-done="${done}">
              <div class="pick-line__top">
                <span class="pick-line__sku">${line.sku}</span>
                <span class="pick-line__qty-badge" data-done="${done}">${line.qtyPicked}/${line.qtyOrdered}</span>
              </div>
              <div class="pick-line__desc">${line.descricao}</div>
              <div class="pick-line__dims">${fmtNumber(line.comprimento, 0)}×${fmtNumber(line.largura, 0)}×${fmtNumber(line.espessura, 0)}mm · ${fmtCurrency(line.unitPrice)}/${line.unidade || 'un'}</div>
              ${!isDraft && order.status !== 'Rascunho' ? `
                <div class="pick-line__actions">
                  <input class="pick-line__qty-input" type="number" step="any" inputmode="decimal"
                    value="${line.qtyOrdered - line.qtyPicked}" min="0" max="${line.qtyOrdered}" />
                  <button class="pick-line__confirm-btn" data-done="${done}" ${done ? 'disabled' : ''}>
                    ${done ? '✓ Separado' : 'Confirmar'}
                  </button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>

      <div class="pick-complete-banner" data-show="${allPicked && !isDraft}">
        <div class="pick-complete-banner__title">✓ Todos os artigos separados</div>
        <button class="pick-complete-btn" id="complete-order-btn">Concluir encomenda</button>
      </div>
    </div>
  `;

  panel.querySelector('#pick-back-btn').addEventListener('click', () => {
    setView('orders');
    renderOrdersList();
  });

  // Draft-specific actions: send to warehouse or cancel
  const draftSendBtn = panel.querySelector('#draft-send-btn');
  if (draftSendBtn) {
    draftSendBtn.addEventListener('click', async () => {
      draftSendBtn.textContent = 'A enviar…';
      draftSendBtn.disabled = true;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Enviado' });
        await loadOrders({ silent: true });
        const updated = orderState.orders.find(o => o.orderId === order.orderId);
        if (updated) renderOrderPick(updated, false);
        toast('Encomenda enviada para armazém', 'success');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
        draftSendBtn.textContent = 'Enviar para armazém';
        draftSendBtn.disabled = false;
      }
    });
  }

  const draftCancelBtn = panel.querySelector('#draft-cancel-btn');
  if (draftCancelBtn) {
    draftCancelBtn.addEventListener('click', async () => {
      if (!confirm('Cancelar esta encomenda?')) return;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Cancelado' });
        await loadOrders({ silent: true });
        renderOrdersList();
        setView('orders');
        toast('Encomenda cancelada', 'default');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
      }
    });
  }

  const startBtn = panel.querySelector('#start-picking-btn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Em separação' });
        await loadOrders({ silent: true });
        const updated = orderState.orders.find(o => o.orderId === order.orderId);
        if (updated) renderOrderPick(updated, false);
        toast('Separação iniciada', 'success');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
      }
    });
  }

  // Wire pick confirm buttons
  panel.querySelectorAll('.pick-line').forEach(lineEl => {
    const sku = lineEl.dataset.sku;
    const confirmBtn = lineEl.querySelector('.pick-line__confirm-btn');
    const qtyInput = lineEl.querySelector('.pick-line__qty-input');
    if (!confirmBtn || !qtyInput) return;

    confirmBtn.addEventListener('click', async () => {
      const qty = parseFloat(qtyInput.value) || 0;
      if (qty <= 0) { toast('Quantidade inválida', 'error'); return; }

      confirmBtn.textContent = 'A guardar…';
      confirmBtn.disabled = true;

      try {
        await apiPost('/api/pick-line', { orderId: order.orderId, sku, qtyPicked: qty });
        // Refresh order and re-render
        const data = await apiGet(`/api/orders?id=${order.orderId}`);
        orderState.currentOrder = data.order;
        // Update in list
        const idx = orderState.orders.findIndex(o => o.orderId === order.orderId);
        if (idx !== -1) orderState.orders[idx] = data.order;
        renderOrderPick(data.order, false);
        toast('Separado', 'success');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
        confirmBtn.textContent = 'Confirmar';
        confirmBtn.disabled = false;
      }
    });
  });

  const completeBtn = panel.querySelector('#complete-order-btn');
  if (completeBtn) {
    completeBtn.addEventListener('click', async () => {
      completeBtn.textContent = 'A concluir…';
      completeBtn.disabled = true;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Concluído' });
        await loadOrders({ silent: true });
        renderOrdersList();
        setView('orders');
        toast('Encomenda concluída', 'success');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
        completeBtn.textContent = 'Concluir encomenda';
        completeBtn.disabled = false;
      }
    });
  }
}

// ---------- wiring ----------
function init() {
  $$('.tabbar__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.goto;
      setView(target);
      if (target === 'browse') renderBrowseList($('#browse-search').value);
      if (target === 'orders') {
        loadOrders().then(() => renderOrdersList());
      }
    });
  });

  $('#new-order-btn').addEventListener('click', async () => {
    if (orderState.clients.length === 0) {
      await loadOrders({ silent: true });
    }
    renderOrderCreate();
    setView('order-create');
  });

  $$('.orders-filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.orders-filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      orderState.filterActive = btn.dataset.filter === 'active';
      renderOrdersList();
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

  // Chrome PWA on Android ignores CSS overscroll-behavior in some versions
  // and triggers its own pull-to-refresh animation. Block it by preventing
  // any downward swipe gesture when the active view is at scroll position 0.
  let touchStartY = 0;
  document.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    const activeView = document.querySelector('.view[data-active="true"]');
    if (!activeView) return;
    const swipingDown = e.touches[0].clientY > touchStartY;
    if (swipingDown && activeView.scrollTop <= 0) {
      e.preventDefault();
    }
  }, { passive: false });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.error('SW registration failed', err));
  }
}

document.addEventListener('DOMContentLoaded', init);
