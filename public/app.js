// app.js — Cedriambar Warehouse App
// No build step. Plain JS, runs directly in the browser.

// ═══════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════
const AUTH_KEY = 'cedriambar_user';

const auth = {
  user: null,
  isWarehouse() { return this.user?.role === 'armazém'; },
  isVendedor()  { return this.user?.role === 'vendedor'; },
};

function saveAuth(user) {
  auth.user = user;
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  updateTopbarUser();
}

function clearAuth() {
  auth.user = null;
  localStorage.removeItem(AUTH_KEY);
  updateTopbarUser();
  showLoginScreen();
}

function loadSavedAuth() {
  try {
    const saved = localStorage.getItem(AUTH_KEY);
    if (saved) auth.user = JSON.parse(saved);
  } catch { auth.user = null; }
}

function updateTopbarUser() {
  const btn    = $('#user-btn');
  const nameEl = $('#user-btn-name');
  const avatar = $('#user-btn-avatar');
  if (!btn) return;
  if (auth.user) {
    if (nameEl) nameEl.textContent = auth.user.name;
    if (avatar) avatar.textContent = auth.user.name.charAt(0).toUpperCase();
    btn.style.display = 'flex';
  } else {
    btn.style.display = 'none';
  }
}

async function showLoginScreen() {
  const overlay = $('#login-overlay');
  const list    = $('#user-list');
  if (!overlay || !list) return;
  overlay.style.display = 'flex';

  try {
    const res  = await fetch('/api/users');
    const data = await res.json();
    const users = data.users || [];

    if (users.length === 0) {
      list.innerHTML = `<div class="login-overlay__loading">
        Adiciona utilizadores no separador "Utilizadores" da Google Sheet.</div>`;
      return;
    }

    list.innerHTML = users.map(u => `
      <button class="login-user-btn" data-id="${u.id}" data-name="${u.name}" data-role="${u.role}">
        <div class="login-user-btn__avatar">${u.name.charAt(0).toUpperCase()}</div>
        <div class="login-user-btn__info">
          <span class="login-user-btn__name">${u.name}</span>
          <span class="login-user-btn__role">${u.role === 'armazém' ? '📦 Armazém' : '🧾 Vendedor'}</span>
        </div>
      </button>
    `).join('');

    list.querySelectorAll('.login-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const user = { id: btn.dataset.id, name: btn.dataset.name, role: btn.dataset.role };
        saveAuth(user);
        overlay.style.display = 'none';
        applyRoleRestrictions();
        await loadOrders({ silent: true });
        renderOrdersList();
        loadAllItems();
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="login-overlay__loading" style="color:var(--danger)">
      Erro ao carregar utilizadores</div>`;
  }
}

function applyRoleRestrictions() {
  const newOrderBtn = $('#new-order-btn');
  if (newOrderBtn) newOrderBtn.style.display = auth.isWarehouse() ? 'none' : '';
}

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
const state = {
  items: [],
  currentItem: null,
  stream: null,
  scanLoopId: null,
};

const orderState = {
  orders: [],
  clients: [],
  currentOrder: null,
  newOrderLines: [],
  newOrderClient: null,
  filterActive: true,
};

// ═══════════════════════════════════════════════════════════
// DOM HELPERS
// ═══════════════════════════════════════════════════════════
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// ═══════════════════════════════════════════════════════════
// VIEW MANAGEMENT + BACK BUTTON
// ═══════════════════════════════════════════════════════════
const viewHistory = [];

function setView(name, { pushHistory = true } = {}) {
  $$('.view').forEach(el => el.dataset.active = String(el.dataset.view === name));
  $$('.tabbar__btn').forEach(el => el.dataset.active = String(el.dataset.goto === name));
  if (name !== 'scan') stopScanner();
  if (pushHistory) {
    viewHistory.push(name);
    history.pushState({ view: name }, '', '');
  }
}

window.addEventListener('popstate', () => {
  viewHistory.pop();
  const prev = viewHistory[viewHistory.length - 1];
  if (!prev) {
    viewHistory.push('scan');
    history.pushState({ view: 'scan' }, '', '');
    setView('scan', { pushHistory: false });
    return;
  }
  setView(prev, { pushHistory: false });
  if (prev === 'orders') renderOrdersList();
  if (prev === 'browse') renderBrowseList($('#browse-search')?.value || '');
});

// ═══════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════
let toastTimer = null;
function toast(message, kind = 'default') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, 2800);
}

// ═══════════════════════════════════════════════════════════
// NUMBER FORMATTING
// ═══════════════════════════════════════════════════════════
function fmtNumber(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('pt-PT', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
function fmtCurrency(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ═══════════════════════════════════════════════════════════
// ITEMS API
// ═══════════════════════════════════════════════════════════
function setConnectionStatus(s, label) {
  const el = $('#connection-status');
  if (!el) return;
  el.dataset.state = s;
  el.textContent = label;
}

async function loadAllItems({ silent = false } = {}) {
  if (!silent) setConnectionStatus('loading', 'a atualizar…');
  try {
    const res = await fetch('/api/items');
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    state.items = data.items || [];
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

// ═══════════════════════════════════════════════════════════
// ITEM DETAIL VIEW
// ═══════════════════════════════════════════════════════════
function renderItemDetail(item) {
  const root = $('#item-detail');
  if (!root) return;

  if (!item) {
    root.innerHTML = `
      <button class="back-btn" data-goto="scan">‹ Voltar</button>
      <div class="item-error">
        <p>Nenhum artigo encontrado</p>
        <p class="item-error__sku">${state.lastFailedSku || ''}</p>
      </div>`;
    root.querySelector('[data-goto]').addEventListener('click', () => setView('scan'));
    return;
  }

  state.currentItem = item;
  const low = item.stock !== null && item.stock <= 0;
  const m2Total = item.unidade === 'm²' && item.dimensaoM2 && item.stock !== null
    ? ` · ${fmtNumber(item.stock * item.dimensaoM2, 2)} m²` : '';

  root.innerHTML = `
    <button class="back-btn" data-goto="scan">‹ Voltar</button>
    <div class="item-detail">
      <div class="item-card__sku">${item.sku}</div>
      <div class="item-card__title">${item.descricao || '(sem descrição)'}</div>
      <div class="item-card__family">${item.familia || ''}</div>

      <div class="dims-strip">
        <div class="dims-strip__cell">
          <div class="dims-strip__value">${fmtNumber(item.comprimento, 0)}</div>
          <div class="dims-strip__label">Compr.</div>
        </div>
        <div class="dims-strip__cell">
          <div class="dims-strip__value">${fmtNumber(item.largura, 0)}</div>
          <div class="dims-strip__label">Largura</div>
        </div>
        <div class="dims-strip__cell">
          <div class="dims-strip__value">${fmtNumber(item.espessura, 0)}</div>
          <div class="dims-strip__label">Esp. mm</div>
        </div>
        <div class="dims-strip__cell">
          <div class="dims-strip__value">${fmtNumber(item.dimensaoM2, 3)}</div>
          <div class="dims-strip__label">m²/un</div>
        </div>
      </div>

      <div class="field-cards">
        <div class="field-card" id="stock-card">
          <div class="field-card__top">
            <span class="field-card__label">Stock</span>
            <span class="field-card__current" data-low="${low}">
              ${fmtNumber(item.stock, 3)} un${m2Total}
            </span>
          </div>
          <div class="stepper">
            <button class="stepper__btn" data-step="-1" type="button">−</button>
            <input class="stepper__input" id="stock-input" type="number" step="any"
              value="${item.stock ?? 0}" inputmode="decimal" />
            <button class="stepper__btn" data-step="1" type="button">+</button>
          </div>
          <button class="field-card__save" id="stock-save" type="button">Guardar stock</button>
        </div>

        <div class="field-card" id="preco-card">
          <div class="field-card__top">
            <span class="field-card__label">Preço de venda</span>
            <span class="field-card__current" id="preco-display">
              ${fmtCurrency(item.preco)}${item.unidade ? '/' + item.unidade : ''}
            </span>
          </div>
          ${!item.unidade ? `
            <div style="margin-bottom:12px">
              <div class="section-label" style="margin-bottom:8px">Unidade de venda</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap" id="unidade-btns">
                ${['un', 'm²', 'ml', 'm³', 'lt'].map(u =>
                  `<button class="unidade-btn" data-unidade="${u}" type="button">${u}</button>`
                ).join('')}
              </div>
            </div>
          ` : ''}
          <div class="stepper">
            <button class="stepper__btn" data-step="-0.5" type="button">−</button>
            <input class="stepper__input" id="preco-input" type="number" step="any"
              value="${item.preco ?? 0}" inputmode="decimal" />
            <button class="stepper__btn" data-step="0.5" type="button">+</button>
          </div>
          <button class="field-card__save" id="preco-save" type="button">Guardar preço</button>
        </div>
      </div>

      ${item.observacoes ? `<div class="purchase-note">${item.observacoes}</div>` : ''}
    </div>`;

  root.querySelector('[data-goto]').addEventListener('click', () => setView('scan'));
  wireFieldCard(root, 'stock', item.stock, val => saveField('stock', val));
  wireFieldCard(root, 'preco', item.preco, val => saveField('preco', val));

  // Unidade buttons — only show when unit not yet set
  root.querySelectorAll('.unidade-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const unit = btn.dataset.unidade;
      const btnsWrap = root.querySelector('#unidade-btns')?.parentElement;
      if (btnsWrap) btnsWrap.style.display = 'none';
      const display = root.querySelector('#preco-display');
      if (display) display.textContent = `${fmtCurrency(item.preco)}/${unit}`;
      await saveField('unidade', unit);
    });
  });
}

function wireFieldCard(root, key, initialValue, onSave) {
  const card    = root.querySelector(`#${key}-card`);
  const input   = root.querySelector(`#${key}-input`);
  const saveBtn = root.querySelector(`#${key}-save`);
  if (!card || !input || !saveBtn) return;

  const baseline = initialValue ?? 0;
  const markDirty = () => {
    saveBtn.dataset.dirty = String(parseFloat(input.value) !== baseline);
  };

  card.querySelectorAll('.stepper__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = Math.round(((parseFloat(input.value) || 0) + parseFloat(btn.dataset.step)) * 1000) / 1000;
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
  if (field === 'stock')   body.stock   = value;
  if (field === 'preco')   body.preco   = value;
  if (field === 'unidade') body.unidade = value;

  try {
    const res = await fetch('/api/update-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('save failed');
    const data = await res.json();
    state.currentItem = { ...state.currentItem, ...data.item };
    const idx = state.items.findIndex(i => i.sku === item.sku);
    if (idx !== -1) state.items[idx] = { ...state.items[idx], ...data.item };
    toast(field === 'stock' ? 'Stock atualizado' : field === 'preco' ? 'Preço atualizado' : 'Unidade guardada', 'success');
    renderItemDetail(state.currentItem);
  } catch (err) {
    console.error(err);
    toast('Falha ao guardar. Tente novamente.', 'error');
    renderItemDetail(state.currentItem);
  }
}

// ═══════════════════════════════════════════════════════════
// SCANNER
// ═══════════════════════════════════════════════════════════
async function handleScannedCode(rawValue) {
  stopScanner();
  const sku = String(rawValue || '').trim();
  setView('item');
  $('#item-detail').innerHTML = `<div style="padding:40px;text-align:center;color:var(--t3);font-family:var(--mono)">A procurar ${sku}…</div>`;
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

async function startScanner() {
  const stage = $('#scan-stage');
  const video = $('#scan-video');

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
  } catch (err) {
    console.error(err);
    toast('Sem acesso à câmara. Verifique as permissões.', 'error');
    return;
  }

  try {
    video.srcObject = state.stream;
    await new Promise(resolve => {
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
  if (state.scanLoopId) { cancelAnimationFrame(state.scanLoopId); state.scanLoopId = null; }
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  if (video) { video.classList.remove('live'); video.srcObject = null; }
  if (stage) stage.dataset.scanning = 'false';
}

let jsQRLoaded = false;
const JSQR_SOURCES = [
  '/jsQR.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.js',
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed: ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureJsQR() {
  if (jsQRLoaded || window.jsQR) { jsQRLoaded = true; return; }
  for (const src of JSQR_SOURCES) {
    try { await loadScript(src); if (window.jsQR) { jsQRLoaded = true; return; } }
    catch (_) { /* try next */ }
  }
  throw new Error('Não foi possível carregar jsQR');
}

function scanLoopFallback(video) {
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d', { willReadFrequently: true });
  const TARGET_WIDTH = 480;

  const tick = () => {
    if (!state.stream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
      const scale = TARGET_WIDTH / video.videoWidth;
      canvas.width  = TARGET_WIDTH;
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height);
      if (code?.data) { handleScannedCode(code.data); return; }
    }
    state.scanLoopId = requestAnimationFrame(tick);
  };
  state.scanLoopId = requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════════
// BROWSE
// ═══════════════════════════════════════════════════════════
function renderBrowseList(query) {
  const list = $('#browse-list');
  if (!list) return;

  if (state.items.length === 0) {
    list.innerHTML = `<div class="browse__loading">A carregar artigos…</div>`;
    return;
  }

  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? state.items.filter(i =>
        i.sku.toLowerCase().includes(q) ||
        i.descricao.toLowerCase().includes(q) ||
        i.familia.toLowerCase().includes(q)
      )
    : state.items;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="browse__empty">Sem resultados para "${query}"</div>`;
    return;
  }

  list.innerHTML = filtered.slice(0, 150).map(item => {
    const low = item.stock !== null && item.stock <= 0;
    return `
      <button class="browse-row" data-sku="${item.sku}">
        <div class="browse-row__main">
          <div class="browse-row__sku">${item.sku} · ${item.familia}</div>
          <div class="browse-row__desc">${item.descricao}</div>
          <div class="browse-row__dims">${fmtNumber(item.comprimento,0)}×${fmtNumber(item.largura,0)}×${fmtNumber(item.espessura,0)}mm · ${fmtCurrency(item.preco)}${item.unidade ? '/'+item.unidade : ''}</div>
        </div>
        <div>
          <span class="browse-row__stock-label">Stock</span>
          <span class="browse-row__stock" data-low="${low}">${fmtNumber(item.stock, 1)}</span>
        </div>
      </button>`;
  }).join('');

  list.querySelectorAll('.browse-row').forEach(row => {
    row.addEventListener('click', () => {
      const item = state.items.find(i => i.sku === row.dataset.sku);
      setView('item');
      renderItemDetail(item);
    });
  });
}

// ═══════════════════════════════════════════════════════════
// ORDERS — API HELPERS
// ═══════════════════════════════════════════════════════════
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
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `${path}: ${res.status}`);
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
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `${path}: ${res.status}`);
  }
  return res.json();
}

async function loadOrders({ silent = false } = {}) {
  try {
    const [od, cd] = await Promise.all([apiGet('/api/orders'), apiGet('/api/clients')]);
    orderState.orders  = od.orders  || [];
    orderState.clients = cd.clients || [];
    return orderState.orders;
  } catch (err) {
    if (!silent) toast('Erro ao carregar encomendas', 'error');
    console.error(err);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// ORDERS LIST
// ═══════════════════════════════════════════════════════════
function isActiveOrder(o) { return !['Concluído','Cancelado'].includes(o.status); }

function renderOrdersList() {
  const list = $('#orders-list');
  if (!list) return;

  const user        = auth.user;
  const isWarehouse = auth.isWarehouse();

  let visible = orderState.orders.filter(order => {
    if (isWarehouse) return ['Enviado','Em separação'].includes(order.status);
    if (order.status === 'Rascunho')  return order.salesperson === user?.name;
    if (order.status === 'Cancelado') return !orderState.filterActive;
    return true;
  });

  if (orderState.filterActive && !isWarehouse) {
    visible = visible.filter(o => !['Concluído','Cancelado'].includes(o.status));
  }

  if (visible.length === 0) {
    list.innerHTML = `<div class="orders-empty">${
      isWarehouse ? 'Sem encomendas para separar' :
      orderState.filterActive ? 'Sem encomendas ativas' : 'Sem encomendas'
    }</div>`;
    return;
  }

  const sorted = [...visible].sort((a, b) => {
    if (isActiveOrder(a) !== isActiveOrder(b)) return isActiveOrder(a) ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  list.innerHTML = sorted.map(order => {
    const totalLines  = order.lines.length;
    const pickedLines = order.lines.filter(l => l.qtyPicked >= l.qtyOrdered).length;
    const pct         = totalLines > 0 ? Math.round((pickedLines / totalLines) * 100) : 0;
    const complete    = pickedLines === totalLines && totalLines > 0;
    const date        = order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-PT') : '';

    return `
      <button class="order-card" data-order-id="${order.orderId}">
        <div class="order-card__top">
          <span class="order-card__id">${order.orderId}</span>
          <span class="order-card__status" data-status="${order.status}">${order.status}</span>
        </div>
        <div class="order-card__client">${order.clientName || '—'}</div>
        <div class="order-card__meta">${totalLines} artigo${totalLines !== 1 ? 's' : ''} · ${date}${order.salesperson ? ' · ' + order.salesperson : ''}</div>
        <div class="order-card__progress">
          <div class="order-card__progress-bar" data-complete="${complete}" style="width:${pct}%"></div>
        </div>
      </button>`;
  }).join('');

  list.querySelectorAll('.order-card').forEach(card => {
    card.addEventListener('click', () => openOrderDetail(card.dataset.orderId));
  });
}

async function openOrderDetail(orderId) {
  const order = orderState.orders.find(o => o.orderId === orderId);
  if (!order) return;
  orderState.currentOrder = order;
  renderOrderPick(order, order.status === 'Rascunho');
  setView('order-pick');
}

// ═══════════════════════════════════════════════════════════
// ORDER CREATE
// ═══════════════════════════════════════════════════════════
function renderOrderCreate() {
  orderState.newOrderLines  = [];
  orderState.newOrderClient = null;

  const panel = $('#order-create-panel');
  if (!panel) return;

  panel.innerHTML = `
    <button class="back-btn" id="create-back-btn">‹ Encomendas</button>
    <div class="order-create">

      <div class="order-create__section">
        <div class="section-label">Cliente</div>
        <div class="client-search-wrap">
          <input class="order-field" id="client-search-input" type="text"
            placeholder="Pesquisar cliente…" autocomplete="off" style="margin:0" />
          <div class="client-search-results" id="client-search-results" style="display:none"></div>
          <div class="client-selected" id="client-selected" style="display:none"></div>
        </div>
        <div style="margin-top:8px">
          <button class="add-item-btn" id="new-client-btn">+ Novo cliente</button>
        </div>
      </div>

      <div class="order-create__section">
        <div class="section-label">Artigos</div>
        <div class="order-lines" id="order-lines-list"></div>
        <button class="add-item-btn" id="add-item-btn">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          Adicionar artigo
        </button>
      </div>

      <div class="order-create__section">
        <div class="section-label">Notas</div>
        <textarea class="order-field" id="order-notes-input" rows="3"
          placeholder="Notas opcionais…" style="resize:none"></textarea>
      </div>

      <div class="order-actions">
        <button class="order-action-btn order-action-btn--draft" id="save-draft-btn">Rascunho</button>
        <button class="order-action-btn order-action-btn--send" id="send-order-btn">Enviar para armazém</button>
      </div>
    </div>`;

  panel.querySelector('#create-back-btn').addEventListener('click', () => setView('orders'));
  panel.querySelector('#add-item-btn').addEventListener('click', () => showItemSearchOverlay());
  panel.querySelector('#new-client-btn').addEventListener('click', () => showNewClientForm());
  panel.querySelector('#save-draft-btn').addEventListener('click', () => submitOrder('Rascunho'));
  panel.querySelector('#send-order-btn').addEventListener('click', () => submitOrder('Enviado'));

  wireClientSearch(panel);
  renderOrderLines();
}

function wireClientSearch(root) {
  const input    = root.querySelector('#client-search-input');
  const results  = root.querySelector('#client-search-results');
  const selected = root.querySelector('#client-selected');

  function selectClient(client) {
    orderState.newOrderClient = client;
    input.style.display       = 'none';
    results.style.display     = 'none';
    selected.style.display    = 'flex';
    selected.innerHTML = `
      <span style="flex:1;font-size:15px;font-weight:600">${client.name}</span>
      <button id="clear-client-btn" type="button" style="background:none;border:none;font-size:12px;color:var(--t3);font-family:var(--font);cursor:pointer">Alterar</button>`;
    selected.querySelector('#clear-client-btn').addEventListener('click', () => {
      orderState.newOrderClient = null;
      input.style.display       = '';
      input.value               = '';
      selected.style.display    = 'none';
      results.style.display     = 'none';
      input.focus();
    });
  }

  function renderResults(q) {
    const ql = q.toLowerCase().trim();
    if (!ql) { results.style.display = 'none'; return; }

    const filtered = orderState.clients.filter(c =>
      c.name.toLowerCase().includes(ql) ||
      c.id.toLowerCase().includes(ql) ||
      (c.nif && c.nif.includes(ql)) ||
      (c.phone && c.phone.includes(ql))
    ).slice(0, 10);

    if (filtered.length === 0) { results.style.display = 'none'; return; }

    results.style.display = 'block';
    results.innerHTML = filtered.map(c => `
      <button class="client-result-row" data-id="${c.id}" type="button">
        <span class="client-result-name">${c.name}</span>
        <span class="client-result-meta">${c.id}${c.nif ? ' · NIF: '+c.nif : ''}${c.phone ? ' · '+c.phone : ''}</span>
      </button>`).join('');

    results.querySelectorAll('.client-result-row').forEach(row => {
      row.addEventListener('click', () => {
        const c = orderState.clients.find(cl => cl.id === row.dataset.id);
        if (c) selectClient(c);
      });
    });
  }

  input.addEventListener('input', e => renderResults(e.target.value));
  input.addEventListener('focus', e => renderResults(e.target.value));
  document.addEventListener('click', e => {
    if (!root.querySelector('.client-search-wrap').contains(e.target))
      results.style.display = 'none';
  });
}

// ═══════════════════════════════════════════════════════════
// ORDER LINES
// ═══════════════════════════════════════════════════════════
function baseQty(line) {
  if (line.unidade === 'm²' && line.dimensaoM2 && (line.qtyMode || 'un') === 'm²')
    return (line.qtyOrdered || 0) / line.dimensaoM2;
  return line.qtyOrdered || 0;
}

function renderOrderLines() {
  const list = $('#order-lines-list');
  if (!list) return;
  if (orderState.newOrderLines.length === 0) { list.innerHTML = ''; return; }

  list.innerHTML = orderState.newOrderLines.map((line, idx) => {
    const nativeUnit    = line.unidade || 'un';
    const hasConversion = nativeUnit !== 'un' && !!line.dimensaoM2;
    const qtyMode       = line.qtyMode || 'un';
    const hasDims       = (line.comprimento || line.largura || line.espessura);
    const convEquiv = hasConversion && qtyMode === 'un'
      ? `= ${fmtNumber((line.qtyOrdered||0) * line.dimensaoM2, 3)} ${nativeUnit}`
      : hasConversion && qtyMode === nativeUnit
      ? `= ${fmtNumber((line.qtyOrdered||0) / line.dimensaoM2, 2)} un`
      : '';
    const lineTotal = (line.qtyOrdered || 0) * (line.unitPrice || 0);

    return `
      <div class="order-line-card" data-idx="${idx}">
        <div class="order-line-card__header-row">
          <div class="order-line-card__info">
            <div class="order-line-card__sku">${line.sku}</div>
            <div class="order-line-card__desc">${line.descricao}</div>
            ${hasDims ? `<div class="order-line-card__dims">${fmtNumber(line.comprimento,0)}×${fmtNumber(line.largura,0)}×${fmtNumber(line.espessura,0)}mm${hasConversion ? ` · ${fmtNumber(line.dimensaoM2,3)} ${nativeUnit}/un` : ''}</div>` : ''}
          </div>
          <button class="order-line-card__remove" data-remove="${idx}" type="button">×</button>
        </div>

        <div class="order-line-card__row">
          <div class="order-line-card__group${hasConversion ? ' order-line-card__group--toggle' : ''}">
            <input class="order-line-card__input" type="number" step="any" inputmode="decimal"
              value="${line.qtyOrdered}" data-field="qty" data-idx="${idx}" placeholder="0" />
            ${hasConversion
              ? `<select class="order-line-card__unit order-line-card__unit--select" data-field="qtymode" data-idx="${idx}">
                   <option value="un" ${qtyMode==='un'?'selected':''}>un</option>
                   <option value="${nativeUnit}" ${qtyMode===nativeUnit?'selected':''}>${nativeUnit}</option>
                 </select>`
              : `<span class="order-line-card__unit">${nativeUnit}</span>`}
          </div>

          <span class="order-line-card__op">×</span>

          <div class="order-line-card__group">
            <span class="order-line-card__unit order-line-card__unit--prefix">€</span>
            <input class="order-line-card__input" type="number" step="any" inputmode="decimal"
              value="${line.unitPrice}" data-field="price" data-idx="${idx}" placeholder="0,00" />
            <span class="order-line-card__unit">/${nativeUnit}</span>
          </div>

          <span class="order-line-card__op">=</span>

          <div class="order-line-card__total" id="line-total-${idx}">${fmtNumber(lineTotal, 2)} €</div>
        </div>

        <div id="qty-label-${idx}" class="order-line-card__equiv">${convEquiv}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      orderState.newOrderLines.splice(parseInt(btn.dataset.remove), 1);
      renderOrderLines();
    });
  });

  list.querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('input', () => {
      const idx  = parseInt(input.dataset.idx);
      const line = orderState.newOrderLines[idx];
      if (input.dataset.field === 'qtymode') {
        line.qtyMode = input.value;
      } else {
        const val = parseFloat(input.value) || 0;
        if (input.dataset.field === 'qty')   line.qtyOrdered = val;
        if (input.dataset.field === 'price') line.unitPrice  = val;
      }

      const totalEl = list.querySelector(`#line-total-${idx}`);
      if (totalEl) {
        totalEl.textContent = `${fmtNumber((line.qtyOrdered||0) * (line.unitPrice||0), 2)} €`;
      }

      const nativeUnit    = line.unidade || 'un';
      const hasConversion = nativeUnit !== 'un' && !!line.dimensaoM2;
      const qtyLabel = list.querySelector(`#qty-label-${idx}`);
      if (qtyLabel && hasConversion) {
        const qty  = line.qtyOrdered || 0;
        const mode = line.qtyMode || 'un';
        qtyLabel.textContent = mode === 'un'
          ? `= ${fmtNumber(qty * line.dimensaoM2, 3)} ${nativeUnit}`
          : `= ${fmtNumber(qty / line.dimensaoM2, 2)} un`;
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════
// ITEM SEARCH OVERLAY (for adding to order)
// ═══════════════════════════════════════════════════════════
async function showItemSearchOverlay() {
  if (state.items.length === 0) {
    toast('A carregar artigos…', 'default');
    await loadAllItems();
  }

  const app     = $('#app');
  const overlay = document.createElement('div');
  overlay.className = 'item-search-overlay';
  overlay.innerHTML = `
    <div class="item-search-overlay__header">
      <input class="item-search-overlay__input" id="item-search-input"
        type="text" placeholder="Pesquisar SKU ou descrição…" autocomplete="off" />
      <button class="item-search-overlay__cancel" id="item-search-cancel">Cancelar</button>
    </div>
    <div class="item-search-overlay__results" id="item-search-results"></div>`;
  app.appendChild(overlay);

  const searchInput = overlay.querySelector('#item-search-input');
  const results     = overlay.querySelector('#item-search-results');

  overlay.querySelector('#item-search-cancel').addEventListener('click', () => overlay.remove());

  function renderResults(q) {
    const ql = (q || '').toLowerCase().trim();
    const filtered = ql
      ? state.items.filter(i =>
          i.sku.includes(ql) ||
          i.sku.replace(/^0+/,'').includes(ql) ||
          i.descricao.toLowerCase().includes(ql) ||
          i.familia.toLowerCase().includes(ql)
        ).slice(0, 60)
      : state.items.slice(0, 60);

    results.innerHTML = filtered.map(item => `
      <button class="browse-row" data-sku="${item.sku}" style="margin-bottom:6px">
        <div class="browse-row__main">
          <div class="browse-row__sku">${item.sku} · ${item.familia}</div>
          <div class="browse-row__desc">${item.descricao}</div>
          <div class="browse-row__dims">${fmtNumber(item.comprimento,0)}×${fmtNumber(item.largura,0)}×${fmtNumber(item.espessura,0)}mm</div>
        </div>
        <div>
          <span class="browse-row__stock-label">Preço</span>
          <span class="browse-row__stock">${fmtCurrency(item.preco)}${item.unidade?'/'+item.unidade:''}</span>
        </div>
      </button>`).join('');

    results.querySelectorAll('.browse-row').forEach(row => {
      row.addEventListener('click', () => {
        const item = state.items.find(i => i.sku === row.dataset.sku);
        if (!item) return;
        orderState.newOrderLines.push({
          sku: item.sku, descricao: item.descricao,
          comprimento: item.comprimento, largura: item.largura, espessura: item.espessura,
          dimensaoM2: item.dimensaoM2, unidade: item.unidade || 'un',
          qtyMode: 'un', qtyOrdered: 1, unitPrice: item.preco || 0
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

// ═══════════════════════════════════════════════════════════
// NEW CLIENT FORM
// ═══════════════════════════════════════════════════════════
function showNewClientForm() {
  const overlay = document.createElement('div');
  overlay.className = 'item-search-overlay';
  overlay.innerHTML = `
    <div class="item-search-overlay__header">
      <span style="font-weight:700;font-size:16px;flex:1">Novo cliente</span>
      <button class="item-search-overlay__cancel" id="client-form-cancel">Cancelar</button>
    </div>
    <div style="padding:16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px">
      <div>
        <div class="section-label" style="margin-bottom:6px">Nome *</div>
        <input class="order-field" id="nc-name" type="text" placeholder="Nome ou empresa" autocomplete="off" style="margin:0" />
      </div>
      <div>
        <div class="section-label" style="margin-bottom:6px">NIF</div>
        <input class="order-field" id="nc-nif" type="text" inputmode="numeric" placeholder="Ex: 501509020" autocomplete="off" style="margin:0" />
      </div>
      <div>
        <div class="section-label" style="margin-bottom:6px">Morada</div>
        <input class="order-field" id="nc-morada" type="text" placeholder="Rua, número" autocomplete="off" style="margin:0 0 8px" />
        <div style="display:flex;gap:8px">
          <input class="order-field" id="nc-postal" type="text" inputmode="numeric" placeholder="Código postal" autocomplete="off" style="margin:0;flex:1" />
          <input class="order-field" id="nc-localidade" type="text" placeholder="Localidade" autocomplete="off" style="margin:0;flex:1.5" />
        </div>
      </div>
      <div>
        <div class="section-label" style="margin-bottom:6px">Contacto</div>
        <input class="order-field" id="nc-phone" type="tel" placeholder="Telefone" autocomplete="off" style="margin:0 0 8px" />
        <input class="order-field" id="nc-mobile" type="tel" placeholder="Telemóvel" autocomplete="off" style="margin:0 0 8px" />
        <input class="order-field" id="nc-email" type="email" placeholder="Email" autocomplete="off" style="margin:0" />
      </div>
      <div>
        <div class="section-label" style="margin-bottom:6px">Notas</div>
        <textarea class="order-field" id="nc-notes" rows="2" placeholder="Notas opcionais…" style="margin:0;resize:none"></textarea>
      </div>
      <button class="order-action-btn order-action-btn--send" id="new-client-save" style="margin-top:8px">Guardar cliente</button>
    </div>`;
  $('#app').appendChild(overlay);

  overlay.querySelector('#client-form-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#new-client-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#nc-name').value.trim();
    if (!name) { toast('Nome é obrigatório', 'error'); return; }

    const nif      = overlay.querySelector('#nc-nif').value.trim();
    const morada   = overlay.querySelector('#nc-morada').value.trim();
    const postal   = overlay.querySelector('#nc-postal').value.trim();
    const local    = overlay.querySelector('#nc-localidade').value.trim();
    const phone    = overlay.querySelector('#nc-phone').value.trim();
    const mobile   = overlay.querySelector('#nc-mobile').value.trim();
    const email    = overlay.querySelector('#nc-email').value.trim();
    const notes    = overlay.querySelector('#nc-notes').value.trim();
    const address  = [morada, postal, local].filter(Boolean).join(', ');
    const notesFmt = [nif?`NIF:${nif}`:'', phone&&mobile?`Tel:${phone}`:'', notes].filter(Boolean).join(' · ');

    const saveBtn = overlay.querySelector('#new-client-save');
    saveBtn.disabled = true; saveBtn.textContent = 'A guardar…';

    try {
      const data = await apiPost('/api/clients', {
        name, nif, address, phone: mobile || phone, email, notes: notesFmt
      });
      orderState.clients.push(data.client);
      overlay.remove();
      renderOrderCreate();
      orderState.newOrderClient = data.client;
      toast(`Cliente "${name}" criado`, 'success');
    } catch (err) {
      toast('Erro ao criar cliente', 'error');
      saveBtn.disabled = false; saveBtn.textContent = 'Guardar cliente';
    }
  });
}

// ═══════════════════════════════════════════════════════════
// SUBMIT ORDER
// ═══════════════════════════════════════════════════════════
async function submitOrder(targetStatus) {
  const client     = orderState.newOrderClient;
  const orderNotes = $('#order-notes-input')?.value.trim() || '';
  const salesperson = auth.user?.name || '';

  if (!client)                           { toast('Selecione um cliente', 'error'); return; }
  if (orderState.newOrderLines.length === 0) { toast('Adicione pelo menos um artigo', 'error'); return; }

  const sendBtn  = $('#send-order-btn');
  const draftBtn = $('#save-draft-btn');
  if (sendBtn)  sendBtn.disabled  = true;
  if (draftBtn) draftBtn.disabled = true;

  try {
    const data = await apiPost('/api/orders', {
      clientId: client.id, clientName: client.name, salesperson, orderNotes,
      lines: orderState.newOrderLines.map(line => ({ ...line, qtyOrdered: baseQty(line) }))
    });
    if (targetStatus === 'Enviado') {
      await apiPatch('/api/orders', { orderId: data.order.orderId, status: 'Enviado' });
    }
    await loadOrders({ silent: true });
    renderOrdersList();
    setView('orders');
    toast(targetStatus === 'Enviado' ? 'Encomenda enviada para armazém' : 'Rascunho guardado', 'success');
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
    if (sendBtn)  sendBtn.disabled  = false;
    if (draftBtn) draftBtn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════
// ORDER PICK VIEW
// ═══════════════════════════════════════════════════════════
function renderOrderPick(order, isDraft) {
  const panel = $('#order-pick-panel');
  if (!panel) return;

  const allPicked  = order.lines.every(l => l.qtyPicked >= l.qtyOrdered);
  const pickedCount = order.lines.filter(l => l.qtyPicked >= l.qtyOrdered).length;

  panel.innerHTML = `
    <button class="back-btn" id="pick-back-btn">‹ Encomendas</button>
    <div class="order-pick">
      <div class="order-pick__header">
        <div class="order-pick__id">${order.orderId} · <span style="color:var(--t3)">${order.status}</span></div>
        <div class="order-pick__client">${order.clientName}</div>
        ${order.orderNotes ? `<div style="font-size:13px;color:var(--t3);margin-top:4px">${order.orderNotes}</div>` : ''}
        <div class="order-pick__progress-row">
          <span class="order-pick__progress-label">${pickedCount} de ${order.lines.length} separados</span>
          ${!isDraft && order.status === 'Enviado'
            ? `<button class="orders-filter-btn active" id="start-picking-btn">Iniciar separação</button>` : ''}
        </div>
      </div>

      ${isDraft ? `
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <button class="order-action-btn order-action-btn--send" id="draft-send-btn" style="flex:2">
            Enviar para armazém
          </button>
          <button class="order-action-btn order-action-btn--draft" id="draft-cancel-btn" style="flex:1;color:var(--danger)">
            Cancelar
          </button>
        </div>` : ''}

      <div class="pick-lines">
        ${order.lines.map(line => {
          const done = line.qtyPicked >= line.qtyOrdered;
          return `
            <div class="pick-line" data-sku="${line.sku}" data-done="${done}">
              <div class="pick-line__top">
                <span class="pick-line__sku">${line.sku}</span>
                <span class="pick-line__qty-badge" data-done="${done}">${line.qtyPicked}/${line.qtyOrdered} ${line.unidade||'un'}</span>
              </div>
              <div class="pick-line__desc">${line.descricao}</div>
              <div class="pick-line__dims">${fmtNumber(line.comprimento,0)}×${fmtNumber(line.largura,0)}×${fmtNumber(line.espessura,0)}mm · ${fmtCurrency(line.unitPrice)}/${line.unidade||'un'}</div>
              ${!isDraft && order.status !== 'Rascunho' ? `
                <div class="pick-line__actions">
                  <input class="pick-line__qty-input" type="number" step="any" inputmode="decimal"
                    value="${line.qtyOrdered - line.qtyPicked}" min="0" />
                  <button class="pick-line__confirm-btn" data-done="${done}" ${done?'disabled':''}>
                    ${done ? '✓ Separado' : 'Confirmar'}
                  </button>
                </div>` : ''}
            </div>`;
        }).join('')}
      </div>

      <div class="pick-complete-banner" data-show="${allPicked && !isDraft}">
        <div class="pick-complete-banner__title">✓ Todos os artigos separados</div>
        <button class="pick-complete-btn" id="complete-order-btn">Concluir encomenda</button>
      </div>

      ${!isDraft && !auth.isWarehouse() && !['Concluído','Cancelado'].includes(order.status) ? `
        <div style="margin-top:16px">
          <button class="btn-danger" id="cancel-active-btn" style="width:100%">Cancelar encomenda</button>
        </div>` : ''}
    </div>`;

  // Back
  panel.querySelector('#pick-back-btn').addEventListener('click', () => {
    setView('orders'); renderOrdersList();
  });

  // Draft: send to warehouse
  const draftSendBtn = panel.querySelector('#draft-send-btn');
  if (draftSendBtn) {
    draftSendBtn.addEventListener('click', async () => {
      draftSendBtn.textContent = 'A enviar…'; draftSendBtn.disabled = true;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Enviado' });
        await loadOrders({ silent: true });
        const updated = orderState.orders.find(o => o.orderId === order.orderId);
        if (updated) renderOrderPick(updated, false);
        toast('Encomenda enviada para armazém', 'success');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
        draftSendBtn.textContent = 'Enviar para armazém'; draftSendBtn.disabled = false;
      }
    });
  }

  // Draft: cancel
  const draftCancelBtn = panel.querySelector('#draft-cancel-btn');
  if (draftCancelBtn) {
    draftCancelBtn.addEventListener('click', async () => {
      if (!confirm('Cancelar esta encomenda?')) return;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Cancelado' });
        await loadOrders({ silent: true });
        renderOrdersList(); setView('orders');
        toast('Encomenda cancelada', 'default');
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
    });
  }

  // Start picking
  const startBtn = panel.querySelector('#start-picking-btn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Em separação' });
        await loadOrders({ silent: true });
        const updated = orderState.orders.find(o => o.orderId === order.orderId);
        if (updated) renderOrderPick(updated, false);
        toast('Separação iniciada', 'success');
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
    });
  }

  // Pick confirm buttons
  panel.querySelectorAll('.pick-line').forEach(lineEl => {
    const sku        = lineEl.dataset.sku;
    const confirmBtn = lineEl.querySelector('.pick-line__confirm-btn');
    const qtyInput   = lineEl.querySelector('.pick-line__qty-input');
    if (!confirmBtn || !qtyInput) return;

    confirmBtn.addEventListener('click', async () => {
      const qty = parseFloat(qtyInput.value) || 0;
      if (qty <= 0) { toast('Quantidade inválida', 'error'); return; }
      confirmBtn.textContent = 'A guardar…'; confirmBtn.disabled = true;
      try {
        await apiPost('/api/pick-line', { orderId: order.orderId, sku, qtyPicked: qty });
        const data = await apiGet(`/api/orders?id=${order.orderId}`);
        orderState.currentOrder = data.order;
        const idx = orderState.orders.findIndex(o => o.orderId === order.orderId);
        if (idx !== -1) orderState.orders[idx] = data.order;
        renderOrderPick(data.order, false);
        toast('Separado', 'success');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
        confirmBtn.textContent = 'Confirmar'; confirmBtn.disabled = false;
      }
    });
  });

  // Cancel active order
  const cancelActiveBtn = panel.querySelector('#cancel-active-btn');
  if (cancelActiveBtn) {
    cancelActiveBtn.addEventListener('click', async () => {
      if (!confirm('Cancelar esta encomenda? Esta ação não pode ser desfeita.')) return;
      cancelActiveBtn.textContent = 'A cancelar…'; cancelActiveBtn.disabled = true;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Cancelado' });
        await loadOrders({ silent: true });
        renderOrdersList(); setView('orders');
        toast('Encomenda cancelada', 'default');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
        cancelActiveBtn.textContent = 'Cancelar encomenda'; cancelActiveBtn.disabled = false;
      }
    });
  }

  // Complete order
  const completeBtn = panel.querySelector('#complete-order-btn');
  if (completeBtn) {
    completeBtn.addEventListener('click', async () => {
      completeBtn.textContent = 'A concluir…'; completeBtn.disabled = true;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Concluído' });
        await loadOrders({ silent: true });
        renderOrdersList(); setView('orders');
        toast('Encomenda concluída', 'success');
      } catch (err) {
        toast('Erro: ' + err.message, 'error');
        completeBtn.textContent = 'Concluir encomenda'; completeBtn.disabled = false;
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
function init() {
  // Tab bar
  $$('.tabbar__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.goto;
      setView(target);
      if (target === 'browse') renderBrowseList($('#browse-search')?.value || '');
      if (target === 'orders') loadOrders().then(() => renderOrdersList());
    });
  });

  // Orders filter
  $$('.orders-filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.orders-filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      orderState.filterActive = btn.dataset.filter === 'active';
      renderOrdersList();
    });
  });

  // New order
  $('#new-order-btn')?.addEventListener('click', async () => {
    if (orderState.clients.length === 0) await loadOrders({ silent: true });
    renderOrderCreate();
    setView('order-create');
  });

  // Scan start
  $('#scan-start-btn')?.addEventListener('click', startScanner);

  // Manual SKU
  $('#manual-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#manual-sku');
    if (input?.value.trim()) { handleScannedCode(input.value.trim()); input.value = ''; }
  });

  // Browse search
  $('#browse-search')?.addEventListener('input', e => renderBrowseList(e.target.value));

  // Refresh
  $('#refresh-btn')?.addEventListener('click', async () => {
    $('#refresh-btn').classList.add('spinning');
    await loadAllItems();
    renderBrowseList($('#browse-search')?.value || '');
    setTimeout(() => $('#refresh-btn').classList.remove('spinning'), 400);
  });

  // Pull-to-refresh prevention
  let touchStartY = 0;
  document.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchmove', e => {
    const activeView = document.querySelector('.view[data-active="true"]');
    if (!activeView) return;
    if (e.touches[0].clientY > touchStartY && activeView.scrollTop <= 0) e.preventDefault();
  }, { passive: false });

  // Auth init
  loadSavedAuth();

  $('#user-btn')?.addEventListener('click', () => {
    if (confirm(`Sair como ${auth.user?.name}?`)) clearAuth();
  });

  if (auth.user) {
    const overlay = $('#login-overlay');
    if (overlay) overlay.style.display = 'none';
    updateTopbarUser();
    applyRoleRestrictions();
    loadAllItems();
  } else {
    showLoginScreen();
  }

  // History
  viewHistory.push('scan');
  history.replaceState({ view: 'scan' }, '', '');

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW:', err));
  }
}

document.addEventListener('DOMContentLoaded', init);
