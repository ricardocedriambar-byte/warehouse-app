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
  isAdmin()     { return this.user?.role === 'admin'; },
};

const ROLE_LABELS = { 'armazém': '📦 Armazém', 'vendedor': '🧾 Vendedor', 'admin': '🔧 Admin' };
function roleLabel(role) { return ROLE_LABELS[role] || role; }

// Small palette of distinct, on-brand hues users can pick for their avatar
// in Settings — first two match the existing green/timber identity colors
// so the defaults stay familiar.
const AVATAR_COLORS = ['#2e9e68', '#c07e38', '#4a9e6a', '#5b8dee', '#c05a4a', '#9d6228', '#8a63d2', '#3fa7c4'];

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
    if (avatar) {
      avatar.textContent = auth.user.name.charAt(0).toUpperCase();
      avatar.style.background = auth.user.avatarColor || '';
    }
    btn.style.display = 'flex';
  } else {
    btn.style.display = 'none';
  }
}

async function showLoginScreen() {
  const overlay = $('#login-overlay');
  const list    = $('#user-list');
  if (!overlay || !list) return;

  // A live camera <video> left running behind this overlay can render
  // through it on Firefox — an actively-streaming video element is
  // sometimes composited via a hardware overlay layer that bypasses normal
  // CSS stacking (z-index/background), regardless of the overlay's own
  // opacity. Stopping it here guarantees nothing is ever playing underneath.
  stopScanner();

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
      <button class="login-user-btn" data-id="${u.id}" data-name="${u.name}" data-role="${u.role}" data-default-tab="${u.defaultTab || ''}" data-avatar-color="${u.avatarColor || ''}">
        <div class="login-user-btn__avatar" style="${u.avatarColor ? `background:${u.avatarColor}` : ''}">${u.name.charAt(0).toUpperCase()}</div>
        <div class="login-user-btn__info">
          <span class="login-user-btn__name">${u.name}</span>
          <span class="login-user-btn__role">${roleLabel(u.role)}</span>
        </div>
      </button>
    `).join('');

    list.querySelectorAll('.login-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const user = {
          id: btn.dataset.id, name: btn.dataset.name, role: btn.dataset.role,
          defaultTab: btn.dataset.defaultTab || '', avatarColor: btn.dataset.avatarColor || ''
        };
        saveAuth(user);
        overlay.style.display = 'none';
        applyRoleRestrictions();
        loadItemsFromCache();
        loadOrders({ silent: true }).then(() => renderOrdersList());
        loadAllItems();
        ensurePushPermissionPrompt();
        // Not awaited on the orders load above — waiting on that network
        // request before switching off the hardcoded Scan screen just
        // means the person watches a Scan → landing-tab flash/slide every
        // time they log in, for no reason (the landing tab's own
        // activateTab() loads whatever data it needs itself).
        applyLandingTab();
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="login-overlay__loading" style="color:var(--danger)">
      Erro ao carregar utilizadores</div>`;
  }
}

// ═══════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
// Replaces the old Resend-email notifications (low stock, order sent) —
// see lib/push.js for the server side. Two capability trade-offs vs email:
// a push payload can't carry the PDF ficha attachment, and since the app
// has no URL-based view routing, tapping a notification can only
// open/focus the app rather than jump straight to the order/item.
const PUSH_ASKED_KEY_PREFIX = 'cedriambar_push_asked_';

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// Subscribes this browser/device to push and saves it against the current
// user. Safe to call repeatedly — pushManager.subscribe() hands back the
// existing subscription if one's already active, and POST /api/push
// upserts by endpoint. Pass requestPermission=true to actually prompt when
// permission is still "default"; pass false to only (re)sync an
// already-granted subscription without ever prompting.
async function subscribeThisDeviceToPush(requestPermission) {
  if (!pushSupported() || !auth.user) return false;

  if (Notification.permission === 'default') {
    if (!requestPermission) return false;
    const result = await Notification.requestPermission();
    if (result !== 'granted') return false;
  } else if (Notification.permission === 'denied') {
    return false;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      const { publicKey } = await apiGet('/api/push');
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }
    await apiPost('/api/push', { userId: auth.user.id, subscription: subscription.toJSON() });
    return true;
  } catch (err) {
    console.error('push subscribe failed:', err);
    return false;
  }
}

function showPushPermissionOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'push-permission-overlay';
  overlay.innerHTML = `
    <div class="push-permission-card">
      <div class="push-permission-card__icon">🔔</div>
      <div class="push-permission-card__title">Ativar notificações?</div>
      <p class="push-permission-card__text">
        Recebe um aviso neste dispositivo quando o stock de um artigo ficar baixo ou uma encomenda for enviada.
      </p>
      <div class="push-permission-card__actions">
        <button class="order-action-btn order-action-btn--draft" id="push-permission-skip">Agora não</button>
        <button class="order-action-btn order-action-btn--send" id="push-permission-enable">Ativar notificações</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const dismiss = () => {
    if (auth.user) localStorage.setItem(PUSH_ASKED_KEY_PREFIX + auth.user.id, '1');
    overlay.remove();
  };

  overlay.querySelector('#push-permission-skip').addEventListener('click', dismiss);
  overlay.querySelector('#push-permission-enable').addEventListener('click', async () => {
    const btn = overlay.querySelector('#push-permission-enable');
    btn.disabled = true;
    btn.textContent = 'A ativar…';
    const ok = await subscribeThisDeviceToPush(true);
    if (!ok && Notification.permission === 'denied') {
      toast('Notificações bloqueadas no browser — podes ativá-las nas definições do site', 'error');
    } else if (!ok) {
      toast('Não foi possível ativar as notificações', 'error');
    } else {
      toast('Notificações ativadas');
    }
    dismiss();
  });
}

// Called once per login (fresh login and returning session alike). Shows
// the one-time "enable notifications" prompt unless this device/user has
// already been asked, or the browser has already granted/denied
// permission at some point (nothing to ask in that case).
function ensurePushPermissionPrompt() {
  if (!pushSupported() || !auth.user) return;

  if (Notification.permission === 'granted') {
    // Already allowed — e.g. enabled from another device/browser earlier —
    // just make sure this device's own subscription is saved, no prompt.
    subscribeThisDeviceToPush(false);
    return;
  }

  if (Notification.permission === 'denied') return; // browser blocks re-prompting anyway

  const askedKey = PUSH_ASKED_KEY_PREFIX + auth.user.id;
  if (localStorage.getItem(askedKey)) return;

  showPushPermissionOverlay();
}

// ─── Notification deep-linking ──────────────────────────────────────────
// The app has no URL-based view routing (every screen lives at "/"), so
// the server encodes the target as a "kind:id" string in a "?push=" query
// param (e.g. "/?push=order:ENC-20260908-1001" or "/?push=item:01100101")
// instead of a real path — see the `url` field built in
// lib/stockAlerts.js/api/notify-order.js and carried through by
// public/sw.js's push/notificationclick handlers.
//
// Two delivery paths land here:
//   - Cold start (no app window open when the notification was tapped):
//     the service worker opens "/?push=...", and applyPendingPushTarget()
//     below reads it from location.search once login/data-loading finishes.
//   - App already open: focusing an existing window doesn't reload it (so
//     it never sees the query string), so the service worker also
//     postMessages the target — handled by the listener registered in
//     init() — and we navigate in place instead.
async function navigateToPushTargetString(pushStr) {
  if (!pushStr || !auth.user) return false;
  const [kind, id] = pushStr.split(':');

  if (kind === 'order' && id) {
    if (!orderState.orders || orderState.orders.length === 0) await loadOrders({ silent: true });
    const order = orderState.orders.find(o => o.orderId === id);
    if (order) openOrderDetail(id);
    else toast(`Encomenda ${id} não encontrada (pode já ter sido processada)`, 'error');
    return true;
  }

  if (kind === 'item' && id) {
    if (!state.items || state.items.length === 0) await loadAllItems();
    const item = state.items.find(i => i.sku === id);
    if (item) { setView('item'); renderItemDetail(item); }
    else toast(`Artigo ${id} não encontrado`, 'error');
    return true;
  }

  return false;
}

// Reads a pending "?push=..." target left in the URL by a cold-start
// notification tap. Clears it from the URL immediately either way, so it
// doesn't linger through later setView() history entries (those push an
// empty '' URL, which — per the History API — keeps whatever query string
// is already there) or get replayed on a page refresh.
async function applyPendingPushTarget() {
  const push = new URLSearchParams(location.search).get('push');
  if (!push) return false;
  history.replaceState(null, '', location.pathname);
  if (!auth.user) return false;
  return navigateToPushTargetString(push);
}

// Sends the current user to their configured landing tab (Settings' "Ecrã
// inicial ao entrar") — called both right after picking a user on the
// login screen and when init() resumes an already-logged-in session from
// localStorage, since that second, far more common case (just reopening
// the app) used to skip this entirely and always leave people on whatever
// the hardcoded starting view is (Scan), no matter what they'd configured.
// A notification tap that required logging in/resuming first (cold start)
// takes priority — it sends them straight to what it was about instead,
// since that's what tapping it would have done if the app were open.
async function applyLandingTab() {
  const wentToPushTarget = await applyPendingPushTarget();
  if (wentToPushTarget) return;
  // "" is the Settings picker's "Início (padrão)" option — it's supposed
  // to mean the Home tab, but the app's actual hardcoded starting view is
  // Scan (see index.html), so treating it as "do nothing" meant anyone on
  // the default landing setting (or who explicitly chose "Início") never
  // got routed anywhere — the one landing page choice that never worked.
  const targetTab = auth.user?.defaultTab || 'home';
  if ($(`.tabbar__btn[data-goto="${targetTab}"]`)) activateTab(targetTab, { instant: true });
}

function applyRoleRestrictions() {
  const newOrderBtn = $('#new-order-btn');
  if (newOrderBtn) newOrderBtn.style.display = (auth.isWarehouse() && !auth.isAdmin()) ? 'none' : '';

  const recursosBtn = $('#recursos-tab-btn');
  if (recursosBtn) recursosBtn.style.display = (auth.isVendedor() || auth.isAdmin()) ? '' : 'none';

  const adminBtn = $('#admin-menu-item');
  if (adminBtn) adminBtn.style.display = auth.isAdmin() ? '' : 'none';
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
  newOrderType: 'Normal',
  editingOrder: null, // set while renderOrderCreate() is reopened to correct an existing order
  filterActive: true,
  loaded: false, // true once loadOrders() has resolved at least once — lets
                 // the Home view tell "still loading" apart from "genuinely zero"
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

// Lateral order of the tab-bar views. Used only to infer a left/right slide
// direction when setView() isn't told one explicitly (e.g. tapping a tab) —
// back-button-style navigation always passes direction: 'back' explicitly
// (see the call sites below), so this order doesn't need to cover every view.
const TAB_ORDER = ['home', 'scan', 'orders', 'browse', 'recursos', 'viaturas'];

// Duration of the view slide transition, in ms — must match the CSS
// transition on .view[data-animating="true"] in app.css.
const VIEW_TX_MS = 320;
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Tracks which view is logically "current" independent of the DOM. During a
// slide transition both the outgoing and incoming .view elements briefly
// carry data-active="true" so they can both stay painted — code that needs
// to know the single current view (refreshVisibleItemViews,
// refreshVisibleOrderViews, nearestScrollableAncestor) reads this instead of
// querying the DOM for [data-active="true"].
let currentViewName = document.querySelector('.view[data-active="true"]')?.dataset.view || 'scan';
let viewAnimating = false;

// Slides `fromEl` out and `toEl` in. direction: 'forward' slides the new
// view in from the right (going deeper / rightward in the tab order);
// 'back' slides it in from the left. Falls back to an instant swap when
// reduced motion is requested or there's nothing to animate from.
function animateViewSwap(fromEl, toEl, direction) {
  if (!fromEl || !toEl || fromEl === toEl || prefersReducedMotion || direction === 'instant') {
    if (fromEl && fromEl !== toEl) fromEl.dataset.active = 'false';
    toEl.dataset.active = 'true';
    return;
  }
  if (viewAnimating) {
    // An earlier transition is still mid-flight — snap it to its end state
    // instantly rather than letting two animations fight over the same
    // elements.
    $$('.view[data-animating="true"]').forEach(el => {
      el.dataset.animating = 'false';
      el.style.transform = '';
    });
  }
  viewAnimating = true;
  const enterFrom = direction === 'back' ? '-100%' : '100%';
  const exitTo = direction === 'back' ? '100%' : '-100%';

  fromEl.dataset.active = 'true';
  toEl.dataset.active = 'true';
  fromEl.dataset.animating = 'true';
  toEl.dataset.animating = 'true';

  // Set the starting positions with transitions disabled, force a reflow so
  // the browser commits them, then re-enable transitions and set the end
  // positions on the next frame — this is what makes the transform change
  // actually animate instead of jumping straight to the end state.
  fromEl.style.transition = 'none';
  toEl.style.transition = 'none';
  fromEl.style.transform = 'translateX(0)';
  toEl.style.transform = `translateX(${enterFrom})`;
  void toEl.offsetWidth;
  fromEl.style.transition = '';
  toEl.style.transition = '';

  requestAnimationFrame(() => {
    fromEl.style.transform = `translateX(${exitTo})`;
    toEl.style.transform = 'translateX(0)';
  });

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    fromEl.dataset.active = 'false';
    fromEl.dataset.animating = 'false';
    toEl.dataset.animating = 'false';
    fromEl.style.transform = '';
    toEl.style.transform = '';
    toEl.removeEventListener('transitionend', onTransitionEnd);
    viewAnimating = false;
  };
  const onTransitionEnd = (e) => {
    if (e.target === toEl && e.propertyName === 'transform') cleanup();
  };
  toEl.addEventListener('transitionend', onTransitionEnd);
  // Safety net in case transitionend never fires (e.g. the tab is
  // backgrounded mid-animation).
  setTimeout(cleanup, VIEW_TX_MS + 80);
}

function setView(name, { pushHistory = true, direction } = {}) {
  const fromName = currentViewName;
  if (name !== fromName) {
    if (direction === undefined) {
      const fromIdx = TAB_ORDER.indexOf(fromName);
      const toIdx = TAB_ORDER.indexOf(name);
      direction = (fromIdx !== -1 && toIdx !== -1 && toIdx < fromIdx) ? 'back' : 'forward';
    }
    const fromEl = document.querySelector(`.view[data-view="${fromName}"]`);
    const toEl = document.querySelector(`.view[data-view="${name}"]`);
    $$('.view').forEach(el => {
      if (el !== fromEl && el.dataset.view !== name) el.dataset.active = 'false';
    });
    if (fromEl && toEl) animateViewSwap(fromEl, toEl, direction);
    else if (toEl) toEl.dataset.active = 'true';
    currentViewName = name;
  }
  $$('.tabbar__btn').forEach(el => el.dataset.active = String(el.dataset.goto === name));
  $('.topbar')?.classList.toggle('topbar--hidden', name === 'viaturas');
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
    setView('scan', { pushHistory: false, direction: 'back' });
    return;
  }
  setView(prev, { pushHistory: false, direction: 'back' });
  if (prev === 'orders') renderOrdersList();
  if (prev === 'browse') renderBrowseList($('#browse-search')?.value || '');
  if (prev === 'home') renderHome();
  if (prev === 'item' && state.currentItem) renderItemDetail(state.currentItem);
  if (prev === 'order-pick' && orderState.currentOrder) {
    renderOrderPick(orderState.currentOrder, orderState.currentOrder.status === 'Rascunho');
  }
});

// ═══════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════
let toastTimer = null;
// Delays calling fn until args stop arriving for `wait` ms — used on search
// inputs so filtering a large (2000+ item) list doesn't run on every
// keystroke, only once typing pauses.
function debounce(fn, wait = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function toast(message, kind = 'default') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, 2800);
}

// Shows a plain, non-technical message to the user while logging the real
// error to the console for debugging. Use this instead of surfacing
// err.message directly, since raw errors (network/API detail) aren't
// meaningful to non-technical users.
function showError(err, fallbackMsg) {
  console.error(err);
  toast(fallbackMsg || 'Ocorreu um erro. Tente novamente.', 'error');
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
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Shimmering row placeholders shown in place of plain "A carregar…" text
// while a list is still fetching (see app.css's .skeleton / .skeleton-row).
function skeletonRows(count = 5) {
  const row = `
    <div class="skeleton-row">
      <div class="skeleton-row__main">
        <div class="skeleton skeleton-row__line skeleton-row__line--wide"></div>
        <div class="skeleton skeleton-row__line skeleton-row__line--mid"></div>
      </div>
      <div class="skeleton skeleton-row__stock"></div>
    </div>`;
  return row.repeat(count);
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

const ITEMS_CACHE_KEY = 'wh_items_cache_v1';

function loadItemsFromCache() {
  try {
    const raw = localStorage.getItem(ITEMS_CACHE_KEY);
    if (!raw) return false;
    const { items } = JSON.parse(raw);
    if (!Array.isArray(items) || items.length === 0) return false;
    state.items = items;
    setConnectionStatus('ok', `${state.items.length} artigos (offline)`);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function saveItemsToCache(items) {
  try {
    localStorage.setItem(ITEMS_CACHE_KEY, JSON.stringify({ items, savedAt: Date.now() }));
  } catch (err) {
    // Storage full or unavailable — non-fatal, just skip caching
    console.error(err);
  }
}

async function loadAllItems({ silent = false } = {}) {
  if (!silent) setConnectionStatus('loading', 'a atualizar…');
  try {
    const res = await fetch('/api/items');
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    state.items = data.items || [];
    saveItemsToCache(state.items);
    setConnectionStatus('ok', `${state.items.length} artigos`);
    refreshVisibleItemViews();
    return state.items;
  } catch (err) {
    console.error(err);
    setConnectionStatus('error', 'sem ligação');
    if (!silent) toast('Não foi possível atualizar os dados', 'error');
    return state.items;
  }
}

// Re-renders whatever item-related screen is currently on-screen after
// state.items changes — otherwise a silent background refresh updates the
// data in memory but the person keeps looking at stale numbers until they
// navigate away and back.
function refreshVisibleItemViews() {
  const viewName = currentViewName;

  if (viewName === 'browse') {
    renderBrowseList($('#browse-search')?.value || '');
  } else if (viewName === 'item' && state.currentItem?.sku) {
    const fresh = state.items.find(i => i.sku === state.currentItem.sku);
    if (fresh) renderItemDetail(fresh);
  } else if (viewName === 'home') {
    renderHome();
  }
}

// Same idea as refreshVisibleItemViews, but for order data — otherwise an
// order edited by someone else (or directly in the sheet) stays stale on
// the Orders list, an open order-pick screen, or the Home dashboard until
// the person happens to navigate away and back.
function refreshVisibleOrderViews() {
  const viewName = currentViewName;

  if (viewName === 'orders') {
    renderOrdersList();
  } else if (viewName === 'order-pick' && orderState.currentOrder?.orderId) {
    const fresh = orderState.orders.find(o => o.orderId === orderState.currentOrder.orderId);
    if (fresh) {
      orderState.currentOrder = fresh;
      renderOrderPick(fresh, fresh.status === 'Rascunho');
    }
  } else if (viewName === 'home') {
    renderHome();
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
    root.querySelector('[data-goto]').addEventListener('click', () => setView('scan', { direction: 'back' }));
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

  root.querySelector('[data-goto]').addEventListener('click', () => setView('scan', { direction: 'back' }));
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
    const res = await fetch('/api/items', {
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
  if (stage) { stage.dataset.scanning = 'false'; stage.dataset.success = 'false'; }
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
  const stage  = $('#scan-stage');
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
      if (code?.data) {
        // Flash the frame green for a beat before navigating away — without
        // this a successful scan looked identical to just pointing the
        // camera somewhere, since the very next thing that happened was the
        // screen changing.
        if (stage) stage.dataset.success = 'true';
        setTimeout(() => handleScannedCode(code.data), prefersReducedMotion ? 0 : 220);
        return;
      }
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
    list.innerHTML = skeletonRows(6);
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
    orderState.loaded  = true;
    refreshVisibleOrderViews();
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

// Shared by the Orders list and the Home dashboard preview, so the two
// never drift into slightly different card markup.
function renderOrderCardHTML(order) {
  const totalLines  = order.lines.length;
  const pickedLines = order.lines.filter(l => l.qtyPicked >= l.qtyOrdered).length;
  const pct         = totalLines > 0 ? Math.round((pickedLines / totalLines) * 100) : 0;
  const complete    = pickedLines === totalLines && totalLines > 0;
  const date        = order.createdAt ? new Date(order.createdAt).toLocaleDateString('pt-PT') : '';

  return `
    <button class="order-card" data-order-id="${order.orderId}">
      <div class="order-card__top">
        <span class="order-card__id">${order.orderId}${order.orderType === 'Portas' ? ' <span class="order-card__type-badge">Portas</span>' : ''}</span>
        <span class="order-card__status" data-status="${order.status}">${order.status}</span>
      </div>
      <div class="order-card__client">${order.clientName || '—'}</div>
      <div class="order-card__meta">${totalLines} artigo${totalLines !== 1 ? 's' : ''} · ${date}${order.salesperson ? ' · ' + order.salesperson : ''}</div>
      <div class="order-card__progress">
        <div class="order-card__progress-bar" data-complete="${complete}" style="width:${pct}%"></div>
      </div>
    </button>`;
}

// order-card__progress-bar already has a CSS width transition, but every
// caller here rebuilds the cards from scratch via innerHTML, so a freshly
// inserted bar has no "before" width to animate from by itself. Tracking
// each order's last-rendered percentage here lets a bar animate only the
// first time an order is seen (a fill-in from 0) or when its percentage
// has genuinely changed since the last render (interpolated from the old
// value) — an order whose progress hasn't changed is left untouched, so a
// routine background refresh no longer flashes every bar back to 0% and
// refills it.
const lastOrderProgressPct = new Map();
function animateProgressBars(container) {
  const bars = container.querySelectorAll('.order-card__progress-bar');
  if (!bars.length) return;
  bars.forEach(bar => {
    const orderId = bar.closest('.order-card')?.dataset.orderId;
    const targetWidth = bar.style.width;
    const targetPct = parseFloat(targetWidth) || 0;
    const prevPct = orderId ? lastOrderProgressPct.get(orderId) : undefined;
    if (orderId) lastOrderProgressPct.set(orderId, targetPct);

    if (prefersReducedMotion || prevPct === targetPct) return;

    bar.style.transition = 'none';
    bar.style.width = (prevPct === undefined ? 0 : prevPct) + '%';
    void bar.offsetWidth;
    bar.style.transition = '';
    requestAnimationFrame(() => { bar.style.width = targetWidth; });
  });
}

function renderOrdersList() {
  const list = $('#orders-list');
  if (!list) return;

  const user        = auth.user;
  const isWarehouse = auth.isWarehouse();

  const backorderCount = orderState.orders.filter(o => o.status === 'Enviado').length;
  const backorderBanner = (!isWarehouse && backorderCount > 0)
    ? `<div class="backorder-banner">
         <span class="backorder-banner__count">${backorderCount}</span>
         encomenda${backorderCount !== 1 ? 's' : ''} por separar (à espera de iniciar separação)
       </div>`
    : '';

  let visible = orderState.orders.filter(order => {
    // Admin sees every order regardless of role — no warehouse-only or
    // own-drafts-only restriction applies.
    if (isWarehouse && !auth.isAdmin()) return order.status === 'Em separação';
    if (order.status === 'Rascunho' && !auth.isAdmin()) return order.salesperson === user?.name;
    if (order.status === 'Cancelado') return !orderState.filterActive;
    return true;
  });

  if (orderState.filterActive && !isWarehouse) {
    visible = visible.filter(o => !['Concluído','Cancelado'].includes(o.status));
  }

  if (visible.length === 0) {
    list.innerHTML = backorderBanner + `<div class="orders-empty">${
      isWarehouse ? 'Sem encomendas para separar' :
      orderState.filterActive ? 'Sem encomendas ativas' : 'Sem encomendas'
    }</div>`;
    return;
  }

  const sorted = [...visible].sort((a, b) => {
    if (isActiveOrder(a) !== isActiveOrder(b)) return isActiveOrder(a) ? -1 : 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  list.innerHTML = backorderBanner + sorted.map(renderOrderCardHTML).join('');
  animateProgressBars(list);
}

// ═══════════════════════════════════════════════════════════
// HOME / DASHBOARD
// ═══════════════════════════════════════════════════════════
function renderHome() {
  const panel = $('#home-panel');
  if (!panel) return;

  const user        = auth.user;
  const isWarehouse = auth.isWarehouse();

  // Same visibility rules as the Orders tab (see renderOrdersList), so the
  // preview here never shows an order this user couldn't open from there.
  let activeOrders = orderState.orders.filter(order => {
    if (isWarehouse && !auth.isAdmin()) return order.status === 'Em separação';
    if (order.status === 'Rascunho' && !auth.isAdmin()) return order.salesperson === user?.name;
    return isActiveOrder(order);
  });
  activeOrders = activeOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const activePreview = activeOrders.slice(0, 3);

  // Only items with a STOCK MÍNIMO set are ever considered "low" — same
  // rule the email alert in lib/stockAlerts.js uses, so this list and the
  // alerts never disagree about which SKUs matter.
  const lowStock = state.items
    .filter(i => i.stockMinimo !== null && i.stockMinimo !== undefined)
    .filter(i => (i.disponivel ?? i.stock ?? 0) < i.stockMinimo)
    .sort((a, b) => (a.disponivel ?? a.stock) - (b.disponivel ?? b.stock));

  const ordersSection = !orderState.loaded
    ? skeletonRows(2)
    : activePreview.length === 0
      ? `<div class="home-empty">Sem encomendas ativas</div>`
      : activePreview.map(renderOrderCardHTML).join('');

  const stockSection = state.items.length === 0
    ? skeletonRows(3)
    : lowStock.length === 0
      ? `<div class="home-empty">Stock dentro dos mínimos definidos</div>`
      : lowStock.slice(0, 8).map(item => {
          const disp = item.disponivel ?? item.stock;
          return `
            <button class="browse-row" data-sku="${item.sku}">
              <div class="browse-row__main">
                <div class="browse-row__sku">${item.sku} · ${item.familia}</div>
                <div class="browse-row__desc">${item.descricao}</div>
              </div>
              <div>
                <span class="browse-row__stock-label">Mín. ${fmtNumber(item.stockMinimo, 0)}</span>
                <span class="browse-row__stock" data-low="true">${fmtNumber(disp, 1)}</span>
              </div>
            </button>`;
        }).join('');

  panel.innerHTML = `
    <div class="home-stats">
      <div class="home-stat">
        <div class="home-stat__value">${orderState.loaded ? activeOrders.length : '—'}</div>
        <div class="home-stat__label">Encomendas ativas</div>
      </div>
      <div class="home-stat" data-warn="${lowStock.length > 0}">
        <div class="home-stat__value">${state.items.length > 0 ? lowStock.length : '—'}</div>
        <div class="home-stat__label">Stock baixo</div>
      </div>
    </div>

    <div class="home-section">
      <div class="section-label" style="padding:0 var(--sp-4)">Encomendas recentes</div>
      <div class="home-section__list">${ordersSection}</div>
    </div>

    <div class="home-section">
      <div class="section-label" style="padding:0 var(--sp-4)">Stock abaixo do mínimo</div>
      <div class="home-section__list">${stockSection}</div>
    </div>
  `;
  animateProgressBars(panel);
}

async function openOrderDetail(orderId, direction) {
  const order = orderState.orders.find(o => o.orderId === orderId);
  if (!order) return;
  orderState.currentOrder = order;
  renderOrderPick(order, order.status === 'Rascunho');
  setView('order-pick', direction ? { direction } : {});
}

// ═══════════════════════════════════════════════════════════
// ORDER CREATE
// ═══════════════════════════════════════════════════════════
// `existingOrder` (optional) switches this into edit mode: it reopens an
// already-created Rascunho/Enviado order for correction instead of
// starting a blank one. Client and order type are locked in that mode —
// only the ficha/materials/notes can change — see buildOrderEditPayload.
function renderOrderCreate(existingOrder = null) {
  orderState.editingOrder = existingOrder || null;
  const isEditing = !!existingOrder;

  orderState.newOrderLines = isEditing
    ? existingOrder.lines.filter(l => !/^PORTA-/.test(l.sku)).map(l => {
        // Reconstructed from the order's own saved lines (real catalog
        // SKUs only — the door BOM lines are regenerated fresh from
        // doorsData, never edited as raw lines). qtyMode is pinned to the
        // line's own unit (not 'un') so baseQty() reads qtyOrdered as-is —
        // it's already stored in the pricing unit, and the order line
        // itself doesn't carry dimensaoM2 to safely convert back.
        const catalogItem = state.items.find(i => i.sku === l.sku);
        return { ...l, qtyMode: l.unidade || 'un', dimensaoM2: catalogItem ? catalogItem.dimensaoM2 : null };
      })
    : [];
  orderState.newOrderClient = isEditing
    ? (orderState.clients.find(c => c.id === existingOrder.clientId) || { id: existingOrder.clientId, name: existingOrder.clientName })
    : null;
  orderState.newOrderType = isEditing ? (existingOrder.orderType || 'Normal') : 'Normal';
  resetDoorsBuilder();
  if (isEditing && orderState.newOrderType === 'Portas' && existingOrder.doorsData) {
    seedDoorsBuilder(existingOrder.doorsData);
  }

  const panel = $('#order-create-panel');
  if (!panel) return;

  const isPortas = orderState.newOrderType === 'Portas';

  panel.innerHTML = `
    <button class="back-btn" id="create-back-btn">‹ ${isEditing ? 'Voltar' : 'Encomendas'}</button>
    <div class="order-create">
      ${isEditing ? `<div class="order-edit-banner">A editar ${existingOrder.orderId} · ${existingOrder.status}</div>` : ''}

      <div class="order-create__section">
        <div class="section-label">Tipo de encomenda</div>
        ${isEditing
          ? `<div class="order-field-locked">${isPortas ? 'Portas' : 'Normal'}</div>`
          : `<div class="doors-tipo-toggle" id="order-type-toggle">
               <button type="button" data-val="Normal" class="active">Normal</button>
               <button type="button" data-val="Portas">Portas</button>
             </div>`}
      </div>

      <div class="order-create__section">
        <div class="section-label">Cliente</div>
        ${isEditing
          ? `<div class="order-field-locked">${dpEsc(orderState.newOrderClient?.name || existingOrder.clientName)}</div>`
          : `<div class="client-search-wrap">
               <input class="order-field" id="client-search-input" type="text"
                 placeholder="Pesquisar cliente…" autocomplete="off" style="margin:0" />
               <div class="client-search-results" id="client-search-results" style="display:none"></div>
               <div class="client-selected" id="client-selected" style="display:none"></div>
             </div>
             <div style="margin-top:8px">
               <button class="add-item-btn" id="new-client-btn">+ Novo cliente</button>
             </div>`}
      </div>

      <div class="order-create__section" id="order-lines-section">
        <div class="section-label" id="order-lines-label">${isPortas ? 'Outros materiais (placas, ferragens, etc.)' : 'Artigos'}</div>
        <div class="order-lines" id="order-lines-list"></div>
        <button class="add-item-btn" id="add-item-btn">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          Adicionar artigo
        </button>
      </div>

      <div class="order-create__section" id="order-doors-section" style="display:${isPortas ? '' : 'none'}">
        <div class="section-label">Portas</div>
        <div id="dp-embed-root"></div>
      </div>

      <div class="order-create__section">
        <div class="section-label">Notas</div>
        <textarea class="order-field" id="order-notes-input" rows="3"
          placeholder="Notas opcionais…" style="resize:none">${dpEsc(existingOrder?.orderNotes || '')}</textarea>
      </div>

      <div class="order-actions">
        ${isEditing
          ? `<button class="order-action-btn order-action-btn--send" id="save-edit-btn" style="flex:1">Guardar alterações</button>`
          : `<button class="order-action-btn order-action-btn--draft" id="save-draft-btn">Rascunho</button>
             <button class="order-action-btn order-action-btn--send" id="send-order-btn">Enviar para armazém</button>`}
      </div>
    </div>`;

  panel.querySelector('#create-back-btn').addEventListener('click', () => {
    if (isEditing) { openOrderDetail(existingOrder.orderId, 'back'); } else { setView('orders', { direction: 'back' }); }
  });
  panel.querySelector('#add-item-btn').addEventListener('click', () => showItemSearchOverlay());

  if (isEditing) {
    panel.querySelector('#save-edit-btn').addEventListener('click', () => confirmAndSaveOrderEdit());
  } else {
    panel.querySelector('#new-client-btn').addEventListener('click', () => showNewClientForm());
    panel.querySelector('#save-draft-btn').addEventListener('click', () => submitOrder('Rascunho'));
    panel.querySelector('#send-order-btn').addEventListener('click', () => confirmAndSendOrder());

    const typeToggle = panel.querySelector('#order-type-toggle');
    typeToggle.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        orderState.newOrderType = btn.dataset.val;
        typeToggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const isPortasNow = orderState.newOrderType === 'Portas';
        // Both sections stay visible in Portas mode — a door order can also
        // need panels, hardware, etc. from the normal catalog.
        panel.querySelector('#order-lines-label').textContent = isPortasNow ? 'Outros materiais (placas, ferragens, etc.)' : 'Artigos';
        panel.querySelector('#order-doors-section').style.display = isPortasNow ? '' : 'none';
        if (isPortasNow) renderDoorsBuilder(panel.querySelector('#dp-embed-root'));
      });
    });

    wireClientSearch(panel);
  }

  if (isPortas) renderDoorsBuilder(panel.querySelector('#dp-embed-root'));
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
  // When the item is sold in m² but the person entered a count of whole
  // units ("un"), convert to the stored base unit (m²) by multiplying by
  // the per-unit area. If they entered the quantity directly in m² (already
  // the native/base unit), no conversion is needed.
  if (line.unidade === 'm²' && line.dimensaoM2 && (line.qtyMode || 'un') === 'un')
    return (line.qtyOrdered || 0) * line.dimensaoM2;
  return line.qtyOrdered || 0;
}

// STOCK/RESERVADO/DISPONÍVEL are always counted in physical pieces ("un"),
// same convention as lib/orders.js's toPieces() and api/pick-line.js's
// piecesPicked — but an order line's qtyOrdered is in the item's *pricing*
// unit (e.g. m²) once baseQty() has run. Comparing those two numbers
// directly — as this used to do — compares apples to oranges: a request
// for 29,925 m² was being weighed against "24" when 24 actually meant 24
// whole panels (≈143 m² at 5,985 m²/panel), so a perfectly fine order got
// flagged as short. Converting the requested quantity back to pieces here
// is what stockWarningText/findInsufficientStockLines below actually need
// to compare against item.disponivel.
function toPiecesQty(item, qtyInPricingUnit) {
  return (item.unidade && item.unidade !== 'un' && item.dimensaoM2)
    ? qtyInPricingUnit / item.dimensaoM2
    : qtyInPricingUnit;
}

// Looks the line's SKU up in the loaded catalog and, if it tracks stock
// and the requested quantity (converted to physical pieces) exceeds what's
// currently available, returns a short warning string — otherwise ''. Used
// both for the live inline hint while building an order and for the
// pre-send shortage summary in findInsufficientStockLines below.
function stockWarningText(line) {
  const item = state.items.find(i => i.sku === line.sku);
  if (!item || item.disponivel === null || item.disponivel === undefined) return '';
  const requestedPieces = toPiecesQty(item, baseQty(line));
  if (requestedPieces <= item.disponivel) return '';
  const hasConversion = item.unidade && item.unidade !== 'un' && !!item.dimensaoM2;
  if (hasConversion) {
    const availablePricing = item.disponivel * item.dimensaoM2;
    return `Apenas ${fmtNumber(item.disponivel)} un (${fmtNumber(availablePricing, 2)} ${item.unidade}) disponíveis`;
  }
  return `Apenas ${fmtNumber(item.disponivel)} ${item.unidade || line.unidade || 'un'} disponíveis`;
}

// Same check as stockWarningText, run across a whole payload/order's lines
// (qtyOrdered already in the item's pricing unit at this point, same as
// what gets written to the sheet) — used right before an order is actually
// sent to the warehouse, since that's the moment reservation kicks in and
// it's too late to notice quietly.
function findInsufficientStockLines(lines) {
  const shortages = [];
  for (const line of lines || []) {
    const item = state.items.find(i => i.sku === line.sku);
    if (!item || item.disponivel === null || item.disponivel === undefined) continue;
    const requestedPieces = toPiecesQty(item, line.qtyOrdered || 0);
    if (requestedPieces > item.disponivel) {
      const hasConversion = item.unidade && item.unidade !== 'un' && !!item.dimensaoM2;
      shortages.push({
        sku: line.sku,
        descricao: item.descricao || line.descricao || '',
        requested: line.qtyOrdered || 0,
        unidade: item.unidade || line.unidade || 'un',
        available: item.disponivel,
        availablePricing: hasConversion ? item.disponivel * item.dimensaoM2 : null
      });
    }
  }
  return shortages;
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
    const discountPct   = line.discountPct || 0;
    const convEquiv = hasConversion && qtyMode === 'un'
      ? `= ${fmtNumber((line.qtyOrdered||0) * line.dimensaoM2, 3)} ${nativeUnit}`
      : hasConversion && qtyMode === nativeUnit
      ? `= ${fmtNumber((line.qtyOrdered||0) / line.dimensaoM2, 2)} un`
      : '';
    const lineTotal = (line.qtyOrdered || 0) * (line.unitPrice || 0) * (1 - discountPct / 100);

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

          <div class="order-line-card__group order-line-card__group--discount">
            <input class="order-line-card__input" type="number" step="any" inputmode="decimal" min="0" max="100"
              value="${discountPct || ''}" data-field="discount" data-idx="${idx}" placeholder="0" />
            <span class="order-line-card__unit">%</span>
          </div>

          <div class="order-line-card__total" id="line-total-${idx}">${fmtNumber(lineTotal, 2)} €</div>
        </div>

        <div id="qty-label-${idx}" class="order-line-card__equiv">${convEquiv}</div>
        <div id="stock-warn-${idx}" class="order-line-card__stock-warn">${stockWarningText(line)}</div>
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
        if (input.dataset.field === 'qty')      line.qtyOrdered   = val;
        if (input.dataset.field === 'price')    line.unitPrice    = val;
        if (input.dataset.field === 'discount') line.discountPct  = Math.min(100, Math.max(0, val));
      }

      const totalEl = list.querySelector(`#line-total-${idx}`);
      if (totalEl) {
        const total = (line.qtyOrdered||0) * (line.unitPrice||0) * (1 - (line.discountPct||0)/100);
        totalEl.textContent = `${fmtNumber(total, 2)} €`;
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

      const warnEl = list.querySelector(`#stock-warn-${idx}`);
      if (warnEl) warnEl.textContent = stockWarningText(line);
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

  // Track the current query so the delegated handler can pass it to the
  // "new product" form. Single listener set up once below, instead of
  // re-attaching per row/button on every debounced keystroke re-render.
  let currentQuery = '';

  function renderResults(q) {
    currentQuery = q || '';
    const ql = currentQuery.toLowerCase().trim();
    const filtered = ql
      ? state.items.filter(i =>
          i.sku.includes(ql) ||
          i.sku.replace(/^0+/,'').includes(ql) ||
          i.descricao.toLowerCase().includes(ql) ||
          i.familia.toLowerCase().includes(ql)
        ).slice(0, 60)
      : state.items.slice(0, 60);

    if (filtered.length === 0) {
      results.innerHTML = `
        <div class="item-search-empty">
          <div class="item-search-empty__text">${ql ? `Nenhum artigo encontrado para "${q}"` : 'Nenhum artigo encontrado'}</div>
          <button class="add-item-btn" data-action="new-product">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
            Adicionar novo produto
          </button>
        </div>`;
      return;
    }

    results.innerHTML = filtered.map(item => {
      const disp = item.disponivel ?? item.stock;
      // Flag it red at zero, or below its STOCK MÍNIMO when one is set —
      // same threshold the Home dashboard and the email alert use, so a
      // vendedor sees the same "low" signal here while building an order.
      const low  = disp !== null && (disp <= 0 || (item.stockMinimo != null && disp < item.stockMinimo));
      return `
      <button class="browse-row" data-sku="${item.sku}" style="margin-bottom:6px">
        <div class="browse-row__main">
          <div class="browse-row__sku">${item.sku} · ${item.familia}</div>
          <div class="browse-row__desc">${item.descricao}</div>
          <div class="browse-row__dims">${fmtNumber(item.comprimento,0)}×${fmtNumber(item.largura,0)}×${fmtNumber(item.espessura,0)}mm</div>
        </div>
        <div style="text-align:right">
          <div>
            <span class="browse-row__stock-label">Preço</span>
            <span class="browse-row__stock">${fmtCurrency(item.preco)}${item.unidade?'/'+item.unidade:''}</span>
          </div>
          <div style="margin-top:4px">
            <span class="browse-row__stock-label">Disp.</span>
            <span class="browse-row__stock" data-low="${low}">${fmtNumber(disp, 1)}</span>
          </div>
        </div>
      </button>`;
    }).join('') + `
      <button class="add-item-btn" data-action="new-product">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5v14m-7-7h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
        Adicionar novo produto
      </button>`;
  }

  results.addEventListener('click', e => {
    const newProductBtn = e.target.closest('[data-action="new-product"]');
    if (newProductBtn) { showNewProductForm(currentQuery, overlay); return; }

    const row = e.target.closest('.browse-row');
    if (!row) return;
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

  searchInput.addEventListener('input', debounce(e => renderResults(e.target.value), 120));
  renderResults('');
  setTimeout(() => searchInput.focus(), 50);
}

// ═══════════════════════════════════════════════════════════
// NEW PRODUCT FORM (ad-hoc line item, added to this order only —
// does not touch the master inventory sheet)
// ═══════════════════════════════════════════════════════════
function showNewProductForm(prefillQuery, searchOverlay) {
  const overlay = document.createElement('div');
  overlay.className = 'item-search-overlay';
  overlay.innerHTML = `
    <div class="item-search-overlay__header">
      <span style="font-weight:700;font-size:16px;flex:1">Novo produto</span>
      <button class="item-search-overlay__cancel" id="np-cancel">Cancelar</button>
    </div>
    <div style="padding:16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px">
      <div class="item-search-empty__hint">Este produto será adicionado apenas a esta encomenda.</div>
      <div>
        <div class="section-label" style="margin-bottom:6px">SKU</div>
        <input class="order-field" id="np-sku" type="text" placeholder="Opcional" autocomplete="off" style="margin:0" />
      </div>
      <div>
        <div class="section-label" style="margin-bottom:6px">Descrição *</div>
        <input class="order-field" id="np-desc" type="text" placeholder="Nome do produto"
          value="${(prefillQuery||'').replace(/"/g,'&quot;')}" autocomplete="off" style="margin:0" />
      </div>
      <div style="display:flex;gap:8px">
        <div style="flex:1">
          <div class="section-label" style="margin-bottom:6px">Unidade</div>
          <select class="order-field" id="np-unidade" style="margin:0">
            <option value="un">un</option>
            <option value="m²">m²</option>
            <option value="ml">ml</option>
            <option value="m³">m³</option>
            <option value="lt">lt</option>
          </select>
        </div>
        <div style="flex:1">
          <div class="section-label" style="margin-bottom:6px">Preço €</div>
          <input class="order-field" id="np-preco" type="number" step="any" inputmode="decimal" placeholder="0,00" style="margin:0" />
        </div>
      </div>
      <button class="order-action-btn order-action-btn--send" id="np-save" style="margin-top:8px">Adicionar à encomenda</button>
    </div>`;
  $('#app').appendChild(overlay);

  overlay.querySelector('#np-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#np-save').addEventListener('click', () => {
    const descricao = overlay.querySelector('#np-desc').value.trim();
    if (!descricao) { toast('Descrição é obrigatória', 'error'); return; }

    const sku     = overlay.querySelector('#np-sku').value.trim();
    const unidade = overlay.querySelector('#np-unidade').value;
    const preco   = parseFloat(overlay.querySelector('#np-preco').value) || 0;

    orderState.newOrderLines.push({
      sku: sku || '—', descricao,
      comprimento: 0, largura: 0, espessura: 0,
      dimensaoM2: null, unidade,
      qtyMode: 'un', qtyOrdered: 1, unitPrice: preco
    });

    overlay.remove();
    if (searchOverlay) searchOverlay.remove();
    renderOrderLines();
    toast(`"${descricao}" adicionado à encomenda`, 'success');
  });
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
      showError(err, 'Não foi possível criar o cliente. Tente novamente.');
      saveBtn.disabled = false; saveBtn.textContent = 'Guardar cliente';
    }
  });
}

// ═══════════════════════════════════════════════════════════
// SUBMIT ORDER
// ═══════════════════════════════════════════════════════════
// Validates the form and builds the exact payload /api/orders expects.
// Returns null (after showing a toast) if something required is missing.
// Shared by the plain draft-save path and the confirm-with-preview path.
function buildOrderSubmissionPayload(targetStatus) {
  const client     = orderState.newOrderClient;
  const orderNotes = $('#order-notes-input')?.value.trim() || '';
  const salesperson = auth.user?.name || '';
  const isPortas = orderState.newOrderType === 'Portas';

  if (!client) { toast('Selecione um cliente', 'error'); return null; }

  if (isPortas) {
    if (!doorsHasContent()) { toast('Adicione pelo menos um tipo de porta', 'error'); return null; }
    // Missing measurements are only a hard block when actually sending to
    // armazém (can't manufacture without them) — a draft can still be
    // saved incomplete and finished later. The live inline warning in the
    // builder itself is shown regardless of targetStatus.
    if (targetStatus === 'Enviado') {
      const issues = doorsValidationIssues();
      if (issues.length > 0) { toast(`Faltam medidas para enviar — ${issues.join(' | ')}`, 'error'); return null; }
    }
    const { lines: doorLines, doorsData } = getDoorsOrderPayload();
    if (doorLines.length === 0) { toast('Preencha as medidas para gerar os materiais', 'error'); return null; }
    const extraLines = orderState.newOrderLines.map(line => ({ ...line, qtyOrdered: baseQty(line) }));
    return {
      clientId: client.id, clientName: client.name, salesperson, orderNotes,
      status: targetStatus, orderType: 'Portas', doorsData,
      lines: [...doorLines, ...extraLines]
    };
  }
  if (orderState.newOrderLines.length === 0) { toast('Adicione pelo menos um artigo', 'error'); return null; }
  return {
    clientId: client.id, clientName: client.name, salesperson, orderNotes,
    status: targetStatus, orderType: 'Normal',
    lines: orderState.newOrderLines.map(line => ({ ...line, qtyOrdered: baseQty(line) }))
  };
}

// Edit-mode counterpart to buildOrderSubmissionPayload — rewrites an
// existing Rascunho/Enviado order's content instead of creating a new
// one. Client, order type and salesperson are locked (carried over from
// the original order, not resubmitted), so this only needs to gather
// notes/lines/doorsData. Measurements are only a hard block here when the
// order is already Enviado — an edited Rascunho can still be saved
// incomplete, exactly like a freshly created one.
function buildOrderEditPayload() {
  const editing = orderState.editingOrder;
  if (!editing) return null;
  const orderNotes = $('#order-notes-input')?.value.trim() || '';
  const isPortas = editing.orderType === 'Portas';

  if (isPortas) {
    if (!doorsHasContent()) { toast('Adicione pelo menos um tipo de porta', 'error'); return null; }
    if (editing.status === 'Enviado') {
      const issues = doorsValidationIssues();
      if (issues.length > 0) { toast(`Faltam medidas para guardar — ${issues.join(' | ')}`, 'error'); return null; }
    }
    const { lines: doorLines, doorsData } = getDoorsOrderPayload();
    if (doorLines.length === 0) { toast('Preencha as medidas para gerar os materiais', 'error'); return null; }
    const extraLines = orderState.newOrderLines.map(line => ({ ...line, qtyOrdered: baseQty(line) }));
    return {
      orderId: editing.orderId, orderNotes, orderType: 'Portas', doorsData,
      lines: [...doorLines, ...extraLines], editedBy: auth.user?.name || ''
    };
  }
  if (orderState.newOrderLines.length === 0) { toast('Adicione pelo menos um artigo', 'error'); return null; }
  return {
    orderId: editing.orderId, orderNotes, orderType: 'Normal',
    lines: orderState.newOrderLines.map(line => ({ ...line, qtyOrdered: baseQty(line) })),
    editedBy: auth.user?.name || ''
  };
}

async function submitOrder(targetStatus) {
  const payload = buildOrderSubmissionPayload(targetStatus);
  if (!payload) return;
  await sendOrderPayload(payload);
}

async function sendOrderPayload(payload) {
  const client = orderState.newOrderClient;
  const sendBtn  = $('#send-order-btn');
  const draftBtn = $('#save-draft-btn');
  if (sendBtn)  sendBtn.disabled  = true;
  if (draftBtn) draftBtn.disabled = true;

  try {
    const data = await apiPost('/api/orders', payload);
    await loadOrders({ silent: true });
    renderOrdersList();
    setView('orders');
    toast(payload.status === 'Enviado' ? 'Encomenda enviada para armazém' : 'Rascunho guardado', 'success');

    // Notify by email the moment it's sent (backorder). Not sent for
    // drafts — only once it actually leaves as an order. This never blocks
    // or fails the order submission itself, which has already succeeded.
    if (payload.status === 'Enviado') {
      notifyOrderByEmail({ ...data.order, salesperson: payload.salesperson, orderNotes: payload.orderNotes }, client);
    }
  } catch (err) {
    showError(err, 'Não foi possível guardar a encomenda. Verifique a ligação e tente novamente.');
    if (sendBtn)  sendBtn.disabled  = false;
    if (draftBtn) draftBtn.disabled = false;
  }
}

// "Enviar para armazém" no longer submits straight away — it first asks
// the server to render the actual Nota de Encomenda PDF (the exact file
// that will be attached to the warehouse email) from the not-yet-saved
// data, and shows that real PDF for a final look before anything is
// written to the sheet.
async function confirmAndSendOrder() {
  const payload = buildOrderSubmissionPayload('Enviado');
  if (!payload) return;

  const client = orderState.newOrderClient;
  const sendBtn = $('#send-order-btn');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'A preparar pré-visualização…'; }

  try {
    const previewOrder = {
      orderId: '(por atribuir)',
      createdAt: new Date().toISOString(),
      salesperson: payload.salesperson,
      orderNotes: payload.orderNotes,
      orderType: payload.orderType,
      lines: payload.lines
    };
    const res = await fetch('/api/order-preview-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: previewOrder, client })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch {}
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const blob = await res.arrayBuffer();
    showSendPreviewOverlay(blob, () => sendOrderPayload(payload), findInsufficientStockLines(payload.lines));
  } catch (err) {
    showError(err, `Não foi possível gerar a pré-visualização${err.message ? ': ' + err.message : ''}.`);
  } finally {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Enviar para armazém'; }
  }
}

// Edit-mode counterpart to confirmAndSendOrder — same "generate the real
// PDF, show it for a final look, only write on confirm" flow, but PATCHes
// the existing order's content in place instead of creating a new one.
// The order's status never changes here; if it was already Enviado, the
// warehouse gets a fresh notification email once the edit is saved, since
// they may already be relying on the version they were first sent.
async function confirmAndSaveOrderEdit() {
  const editing = orderState.editingOrder;
  if (!editing) return;
  const payload = buildOrderEditPayload();
  if (!payload) return;

  const client = orderState.newOrderClient;
  const saveBtn = $('#save-edit-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'A preparar pré-visualização…'; }

  try {
    const previewOrder = {
      orderId: editing.orderId,
      createdAt: editing.createdAt,
      salesperson: editing.salesperson,
      orderNotes: payload.orderNotes,
      orderType: payload.orderType,
      lines: payload.lines
    };
    const res = await fetch('/api/order-preview-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: previewOrder, client })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch {}
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const blob = await res.arrayBuffer();
    showSendPreviewOverlay(
      blob,
      async () => {
        try {
          const data = await apiPatch('/api/orders', payload);
          await loadOrders({ silent: true });
          const updated = (data && data.order) || orderState.orders.find(o => o.orderId === editing.orderId);
          toast('Alterações guardadas', 'success');
          // Only an already-Enviado order needs to re-notify the warehouse
          // — a Rascunho edit never emailed anyone in the first place.
          if (editing.status === 'Enviado') {
            notifyOrderByEmail({ ...(updated || editing), orderNotes: payload.orderNotes }, client);
          }
          orderState.editingOrder = null;
          if (updated) { openOrderDetail(updated.orderId); } else { setView('orders'); renderOrdersList(); }
        } catch (err) {
          showError(err, 'Não foi possível guardar as alterações. Tente novamente.');
        }
      },
      findInsufficientStockLines(payload.lines),
      { ok: 'Guardar alterações', shortage: 'Guardar mesmo assim', progress: 'A guardar…' }
    );
  } catch (err) {
    showError(err, `Não foi possível gerar a pré-visualização${err.message ? ': ' + err.message : ''}.`);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Guardar alterações'; }
  }
}

// PDF.js is loaded lazily from a CDN, only the first time a preview is
// needed — it renders the PDF into a <canvas> ourselves instead of
// relying on the platform's native PDF viewer, which is unreliable
// inside an embedded view on both iOS Safari and Android Chrome (shows
// a bare "download" prompt instead of the actual page).
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (window.__pdfjsLoadingPromise) return window.__pdfjsLoadingPromise;
  window.__pdfjsLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve();
    };
    script.onerror = () => reject(new Error('Falha ao carregar o visualizador de PDF'));
    document.head.appendChild(script);
  });
  return window.__pdfjsLoadingPromise;
}

async function renderPdfIntoCanvas(canvas, pdfBytes) {
  await loadPdfJs();
  const pdf = await window.pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const page = await pdf.getPage(1);
  const containerWidth = canvas.parentElement.clientWidth;
  const baseViewport = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const scale = (containerWidth / baseViewport.width) * dpr;
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = containerWidth + 'px';
  canvas.style.height = (viewport.height / dpr) + 'px';

  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

function showSendPreviewOverlay(pdfBytes, onConfirm, shortages = [], labels = {}) {
  const okLabel       = labels.ok || 'Confirmar e enviar';
  const shortageLabel = labels.shortage || 'Enviar mesmo assim';
  const overlay = document.createElement('div');
  overlay.className = 'send-preview-overlay';
  // Soft warning, not a hard block: reservation only starts once the order
  // is actually sent, and there's no check before this point stopping
  // someone from ordering more than what's available — so this is the
  // last moment to notice before the warehouse does instead. Sending
  // anyway is still one tap away, since a real, if unusual, reason to
  // order over stock (an incoming restock, a customer waiting either way)
  // shouldn't be blocked outright.
  const shortageBanner = shortages.length > 0 ? `
    <div class="stock-warning-banner">
      <div class="stock-warning-banner__title">⚠ Stock insuficiente para ${shortages.length} artigo${shortages.length !== 1 ? 's' : ''}</div>
      <ul class="stock-warning-banner__list">
        ${shortages.map(s => `<li>${s.sku} — ${s.descricao}: pede ${fmtNumber(s.requested)} ${s.unidade}, há ${fmtNumber(s.available)} un${s.availablePricing !== null ? ` (${fmtNumber(s.availablePricing, 2)} ${s.unidade})` : ''} disponível</li>`).join('')}
      </ul>
    </div>` : '';
  overlay.innerHTML = `
    <div class="send-preview-overlay__header">
      <span class="send-preview-overlay__title">Confirmar encomenda</span>
      <button class="send-preview-overlay__close" id="send-preview-close" aria-label="Fechar">✕</button>
    </div>
    ${shortageBanner}
    <div class="send-preview-overlay__scroll" id="send-preview-scroll">
      <canvas class="send-preview-overlay__canvas" id="send-preview-canvas"></canvas>
    </div>
    <div class="send-preview-overlay__actions">
      <button class="order-action-btn order-action-btn--draft" id="send-preview-back">Voltar a editar</button>
      <button class="order-action-btn order-action-btn--send" id="send-preview-confirm">${shortages.length > 0 ? shortageLabel : okLabel}</button>
    </div>`;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('#send-preview-canvas');
  renderPdfIntoCanvas(canvas, pdfBytes).catch(err => {
    console.error(err);
    overlay.querySelector('#send-preview-scroll').innerHTML =
      '<p class="send-preview-overlay__fallback">Não foi possível mostrar a pré-visualização, mas podes continuar a enviar normalmente.</p>';
  });

  const cleanup = () => overlay.remove();
  overlay.querySelector('#send-preview-close').addEventListener('click', cleanup);
  overlay.querySelector('#send-preview-back').addEventListener('click', cleanup);
  overlay.querySelector('#send-preview-confirm').addEventListener('click', async () => {
    const confirmBtn = overlay.querySelector('#send-preview-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = labels.progress || 'A enviar…';
    await onConfirm();
    cleanup();
  });
}

// ═══════════════════════════════════════════════════════════
// EMAIL NOTIFICATION — sent to Ricardo whenever an order goes to backorder.
// The HTML body and the filled "Nota de Encomenda" PDF attachment are both
// built server-side (see api/notify-order.js and lib/pdf-order-note.js) —
// this just forwards the raw order + client data.
// ═══════════════════════════════════════════════════════════
async function notifyOrderByEmail(order, client) {
  try {
    await apiPost('/api/notify-order', { order, client });
  } catch (err) {
    // Never surface this to the user or block their flow — the order
    // itself already saved successfully. Just log it for debugging.
    console.error('notifyOrderByEmail failed', err);
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
  // Only the ficha's own owner (or an admin) can correct it, and only
  // while the warehouse hasn't started pulling materials for it yet —
  // once picking begins (or it's finished/cancelled), it's frozen.
  const canEditOrder = (order.status === 'Rascunho' || order.status === 'Enviado')
    && (auth.user?.name === order.salesperson || auth.isAdmin());

  panel.innerHTML = `
    <button class="back-btn" id="pick-back-btn">‹ Encomendas</button>
    <div class="order-pick">
      <div class="order-pick__header">
        <div class="order-pick__id">${order.orderId}${order.orderType === 'Portas' ? ' <span class="order-card__type-badge">Portas</span>' : ''} · <span style="color:var(--t3)">${order.status}</span></div>
        <div class="order-pick__client">${order.clientName}</div>
        ${order.orderNotes ? `<div style="font-size:13px;color:var(--t3);margin-top:4px">${order.orderNotes}</div>` : ''}
        ${order.editedBy ? `<div class="order-pick__edited-note">Editado por ${order.editedBy}${fmtDateTime(order.editedAt) ? ' às ' + fmtDateTime(order.editedAt) : ''}</div>` : ''}
        <div class="order-pick__progress-row">
          <span class="order-pick__progress-label">${pickedCount} de ${order.lines.length} separados</span>
          ${!isDraft && order.status === 'Enviado'
            ? `<button class="orders-filter-btn active" id="start-picking-btn">Iniciar separação</button>` : ''}
        </div>
      </div>

      ${canEditOrder ? `
        <button class="btn-ghost doors-full-btn" id="edit-order-btn" style="margin-bottom:12px">✎ Editar ficha</button>` : ''}

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
        ${order.lines.map((line, lineIndex) => {
          const done = line.qtyPicked >= line.qtyOrdered;
          const perUnitArea = (line.unidade === 'm²' && line.comprimento && line.largura)
            ? (line.comprimento * line.largura) / 1_000_000 : 0;
          const unitsEquiv = perUnitArea > 0
            ? ` (≈ ${fmtNumber(line.qtyOrdered / perUnitArea, 2)} un)` : '';
          const remainingNative = line.qtyOrdered - line.qtyPicked;
          // Default to picking in whole units when the item's dimensions
          // are known — that's what the warehouse actually grabs off the
          // shelf, not a decimal m² figure.
          const defaultQty = perUnitArea > 0
            ? fmtNumber(remainingNative / perUnitArea, 3)
            : fmtNumber(remainingNative, 3);
          // Portas orders can mix synthetic door-BOM lines (no SKU, no
          // price — they're never stock-tracked) with real catalog items
          // (placas, ferragens, etc.) added alongside them, so this is
          // decided per line, not per order.
          const isDoorLine = /^PORTA-/.test(line.sku);
          const isIndented = /^\s/.test(line.descricao || '');
          return `
            <div class="pick-line" data-sku="${line.sku}" data-line-index="${lineIndex}" data-done="${done}" data-per-unit-area="${perUnitArea}">
              <div class="pick-line__top">
                ${isDoorLine ? '' : `<span class="pick-line__sku">${line.sku}</span>`}
                <span class="pick-line__qty-badge" data-done="${done}">${line.qtyPicked}/${line.qtyOrdered} ${line.unidade||'un'}${unitsEquiv}</span>
              </div>
              <div class="pick-line__desc"${isIndented ? ' style="padding-left:16px;color:var(--t2);font-size:13px"' : ''}>${line.descricao.trim()}</div>
              ${isIndented ? '' : `<div class="pick-line__dims">${fmtNumber(line.comprimento,0)}×${fmtNumber(line.largura,0)}×${fmtNumber(line.espessura,0)}mm${line.unitPrice ? ` · ${fmtCurrency(line.unitPrice)}/${line.unidade||'un'}` : ''}</div>`}
              ${order.status === 'Em separação' ? `
                <div class="pick-line__actions">
                  <div class="pick-line__qty-group">
                    <input class="pick-line__qty-input" type="number" step="any" inputmode="decimal"
                      value="${defaultQty}" min="0" />
                    ${perUnitArea > 0
                      ? `<select class="pick-line__unit-select">
                           <option value="un" selected>un</option>
                           <option value="${line.unidade}">${line.unidade}</option>
                         </select>`
                      : `<span class="pick-line__unit-label">${line.unidade||'un'}</span>`}
                  </div>
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

      ${!isDraft && !auth.isWarehouse() && order.status !== 'Cancelado' ? `
        <div style="margin-top:16px">
          <button class="btn-danger" id="cancel-active-btn" style="width:100%">Cancelar encomenda</button>
        </div>` : ''}
    </div>`;

  // Back
  panel.querySelector('#pick-back-btn').addEventListener('click', () => {
    setView('orders', { direction: 'back' }); renderOrdersList();
  });

  // Edit ficha (Rascunho or Enviado, owner/admin only — see canEditOrder)
  const editOrderBtn = panel.querySelector('#edit-order-btn');
  if (editOrderBtn) {
    editOrderBtn.addEventListener('click', () => {
      renderOrderCreate(order);
      setView('order-create');
    });
  }

  // Draft: send to warehouse
  const draftSendBtn = panel.querySelector('#draft-send-btn');
  if (draftSendBtn) {
    draftSendBtn.addEventListener('click', async () => {
      draftSendBtn.textContent = 'A preparar pré-visualização…'; draftSendBtn.disabled = true;
      const fullClient = orderState.clients.find(c => c.id === order.clientId);
      try {
        const res = await fetch('/api/order-preview-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order, client: fullClient })
        });
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.json()).error || ''; } catch {}
          throw new Error(detail || `HTTP ${res.status}`);
        }
        const blob = await res.arrayBuffer();
        showSendPreviewOverlay(blob, async () => {
          await apiPatch('/api/orders', { orderId: order.orderId, status: 'Enviado' });
          await loadOrders({ silent: true });
          const updated = orderState.orders.find(o => o.orderId === order.orderId);
          if (updated) renderOrderPick(updated, false);
          toast('Encomenda enviada para armazém', 'success');
          notifyOrderByEmail(updated || order, fullClient);
        }, findInsufficientStockLines(order.lines));
      } catch (err) {
        showError(err, `Não foi possível gerar a pré-visualização${err.message ? ': ' + err.message : ''}.`);
      } finally {
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
      } catch (err) { showError(err, 'Não foi possível cancelar a encomenda. Tente novamente.'); }
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
      } catch (err) { showError(err, 'Não foi possível iniciar a separação. Tente novamente.'); }
    });
  }

  // Pick confirm buttons
  panel.querySelectorAll('.pick-line').forEach(lineEl => {
    const sku          = lineEl.dataset.sku;
    const lineIndex    = Number(lineEl.dataset.lineIndex);
    const perUnitArea  = parseFloat(lineEl.dataset.perUnitArea) || 0;
    const confirmBtn   = lineEl.querySelector('.pick-line__confirm-btn');
    const qtyInput     = lineEl.querySelector('.pick-line__qty-input');
    const unitSelect   = lineEl.querySelector('.pick-line__unit-select');
    if (!confirmBtn || !qtyInput) return;

    // Looked up by position, not by SKU — two lines in the same order can
    // share a SKU (the same catalog item added twice, or two "no SKU"
    // ad-hoc products, which both read back as the placeholder "—"), and
    // matching by SKU alone would resolve to the wrong line in that case.
    const line = order.lines[lineIndex];
    const remainingNative = line ? (line.qtyOrdered - line.qtyPicked) : 0;

    // Re-express the current input value when the unit toggle changes,
    // instead of leaving a now-mismatched number sitting in the field.
    if (unitSelect) {
      unitSelect.addEventListener('change', () => {
        qtyInput.value = unitSelect.value === 'un'
          ? fmtNumber(remainingNative / perUnitArea, 3)
          : fmtNumber(remainingNative, 3);
      });
    }

    confirmBtn.addEventListener('click', async () => {
      const entered = parseFloat(qtyInput.value) || 0;
      if (entered <= 0) { toast('Quantidade inválida', 'error'); return; }
      // Always send qtyPicked in the item's native/stored unit — convert up
      // from "un" if that's what's currently selected.
      const qty = (unitSelect && unitSelect.value === 'un')
        ? entered * perUnitArea
        : entered;
      confirmBtn.textContent = 'A guardar…'; confirmBtn.disabled = true;
      try {
        await apiPost('/api/pick-line', { orderId: order.orderId, sku, qtyPicked: qty, lineIndex });
        const data = await apiGet(`/api/orders?id=${order.orderId}`);
        orderState.currentOrder = data.order;
        const idx = orderState.orders.findIndex(o => o.orderId === order.orderId);
        if (idx !== -1) orderState.orders[idx] = data.order;
        // renderOrderPick below rebuilds the whole panel from scratch, so
        // without this the line would just vanish and reappear dimmed —
        // a beat of visible confirmation first makes the pick feel
        // registered rather than an instant, silent DOM swap.
        lineEl.classList.add('pick-line--confirmed');
        if (!prefersReducedMotion) await new Promise(r => setTimeout(r, 260));
        renderOrderPick(data.order, false);
        toast('Separado', 'success');
        loadAllItems({ silent: true }); // stock just changed — refresh in the background
      } catch (err) {
        showError(err, 'Não foi possível guardar a quantidade separada. Tente novamente.');
        confirmBtn.textContent = 'Confirmar'; confirmBtn.disabled = false;
      }
    });
  });

  // Cancel active order
  const cancelActiveBtn = panel.querySelector('#cancel-active-btn');
  if (cancelActiveBtn) {
    cancelActiveBtn.addEventListener('click', async () => {
      const hasPicked = order.lines.some(l => l.qtyPicked > 0);
      const msg = hasPicked
        ? 'Cancelar esta encomenda? O stock já separado será reposto. Esta ação não pode ser desfeita.'
        : 'Cancelar esta encomenda? Esta ação não pode ser desfeita.';
      if (!confirm(msg)) return;
      cancelActiveBtn.textContent = 'A cancelar…'; cancelActiveBtn.disabled = true;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Cancelado' });
        await loadOrders({ silent: true });
        renderOrdersList(); setView('orders');
        toast('Encomenda cancelada', 'default');
        loadAllItems({ silent: true }); // cancelling can restore stock — refresh in the background
      } catch (err) {
        showError(err, 'Não foi possível cancelar a encomenda. Tente novamente.');
        cancelActiveBtn.textContent = 'Cancelar encomenda'; cancelActiveBtn.disabled = false;
      }
    });
  }

  // Complete order
  const completeBtn = panel.querySelector('#complete-order-btn');
  if (completeBtn) {
    completeBtn.addEventListener('click', async () => {
      if (!confirm('Concluir esta encomenda? Deixará de aparecer como ativa.')) return;
      completeBtn.textContent = 'A concluir…'; completeBtn.disabled = true;
      try {
        await apiPatch('/api/orders', { orderId: order.orderId, status: 'Concluído' });
        await loadOrders({ silent: true });
        renderOrdersList(); setView('orders');
        toast('Encomenda concluída', 'success');
      } catch (err) {
        showError(err, 'Não foi possível concluir a encomenda. Tente novamente.');
        completeBtn.textContent = 'Concluir encomenda'; completeBtn.disabled = false;
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════
// SETTINGS (per-user)
// ═══════════════════════════════════════════════════════════
async function renderSettings() {
  const panel = $('#settings-panel');
  if (!panel || !auth.user) return;

  // auth.user (from localStorage / the login list) only carries the
  // minimal fields the login screen needs (id/name/role/defaultTab/
  // avatarColor) — fetch the full record so email and notification
  // toggles aren't shown blank even when they were set previously.
  panel.innerHTML = `<button class="back-btn" id="settings-back-btn">‹ Voltar</button>` + skeletonRows(3);
  // Settings can be opened from the user menu on any screen (Home, Scan,
  // Encomendas, Inventário…), so "back" needs to return to wherever that
  // was — not always Home. Going through the browser's own back
  // navigation (which setView's pushState already recorded) re-uses the
  // popstate handler that knows the real previous screen.
  panel.querySelector('#settings-back-btn').addEventListener('click', () => history.back());

  let u = auth.user;
  try {
    const res = await fetch('/api/users?all=true');
    const data = await res.json();
    const full = (data.users || []).find(x => x.id === auth.user.id);
    if (full) u = full;
  } catch (err) {
    console.error('settings: failed to load full profile, using cached fields', err);
  }

  renderSettingsForm(panel, u);
}

function renderSettingsForm(panel, u) {
  const tabOptions = [
    ['', 'Início (padrão)'], ['scan', 'Digitalizar'], ['orders', 'Encomendas'],
    ['browse', 'Inventário'], ['recursos', 'Recursos'], ['viaturas', 'Viaturas']
  ];

  panel.innerHTML = `
    <button class="back-btn" id="settings-back-btn">‹ Voltar</button>

    <div class="settings-card">
      <div class="settings-profile">
        <div class="settings-profile__avatar" id="settings-avatar-preview" style="${u.avatarColor ? `background:${u.avatarColor}` : ''}">${u.name.charAt(0).toUpperCase()}</div>
        <div>
          <div class="settings-profile__name">${u.name}</div>
          <div class="settings-profile__role">${roleLabel(u.role)}</div>
        </div>
      </div>
      <input class="order-field" id="settings-email" type="email" placeholder="email para notificações" value="${u.email || ''}" style="margin-bottom:0" />
    </div>

    <div class="section-label">Notificações</div>
    <div class="settings-card">
      <label class="toggle-row">
        <span>Novas encomendas enviadas</span>
        <input type="checkbox" id="settings-notify-orders" ${u.notifyOrders ? 'checked' : ''} />
        <span class="toggle-switch"></span>
      </label>
      <label class="toggle-row">
        <span>Alertas de stock baixo</span>
        <input type="checkbox" id="settings-notify-lowstock" ${u.notifyLowStock ? 'checked' : ''} />
        <span class="toggle-switch"></span>
      </label>
      <p class="settings-hint">Recebidas como notificação push neste dispositivo (e por email, no caso de encomendas). Também é preciso ativar as notificações do browser — se ainda não o fizeste, sai e volta a entrar para veres esse pedido.</p>
      <button class="order-action-btn order-action-btn--draft" id="settings-test-push-btn" type="button" style="width:100%;margin-top:var(--sp-3)">Enviar notificação de teste</button>
      ${u.role === 'admin' ? `
      <p class="settings-hint">Estes dois simulam um alerta real (a quem tem cada opção ativada em Definições) — usa se o teste acima funcionar mas os alertas reais não chegarem.</p>
      <button class="order-action-btn order-action-btn--draft" id="settings-test-orders-btn" type="button" style="width:100%;margin-top:var(--sp-2)">Simular alerta: encomenda enviada</button>
      <button class="order-action-btn order-action-btn--draft" id="settings-test-lowstock-btn" type="button" style="width:100%;margin-top:var(--sp-2)">Simular alerta: stock baixo</button>
      ` : ''}
    </div>

    <div class="section-label">Ecrã inicial ao entrar</div>
    <div class="settings-card">
      <select class="order-field" id="settings-default-tab" style="margin-bottom:0">
        ${tabOptions.map(([v, l]) => `<option value="${v}" ${u.defaultTab === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>

    <div class="section-label">Cor do avatar</div>
    <div class="settings-card">
      <div class="avatar-color-picker" id="avatar-color-picker">
        ${AVATAR_COLORS.map(c => `<button type="button" class="avatar-color-swatch" data-color="${c}" data-selected="${u.avatarColor === c}" style="background:${c}"></button>`).join('')}
      </div>
    </div>

    <button class="btn-primary" id="settings-save-btn" style="width:100%;margin-top:var(--sp-2)">Guardar</button>
  `;

  // Settings can be opened from the user menu on any screen (Home, Scan,
  // Encomendas, Inventário…), so "back" needs to return to wherever that
  // was — not always Home. Going through the browser's own back
  // navigation (which setView's pushState already recorded) re-uses the
  // popstate handler that knows the real previous screen.
  panel.querySelector('#settings-back-btn').addEventListener('click', () => history.back());

  let selectedColor = u.avatarColor || '';
  panel.querySelectorAll('.avatar-color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      selectedColor = sw.dataset.color;
      panel.querySelectorAll('.avatar-color-swatch').forEach(s => s.dataset.selected = String(s === sw));
      const preview = $('#settings-avatar-preview');
      if (preview) preview.style.background = selectedColor;
    });
  });

  panel.querySelector('#settings-save-btn').addEventListener('click', async () => {
    const btn = panel.querySelector('#settings-save-btn');
    btn.disabled = true; btn.textContent = 'A guardar…';
    const fields = {
      email: $('#settings-email').value.trim(),
      notifyOrders: $('#settings-notify-orders').checked,
      notifyLowStock: $('#settings-notify-lowstock').checked,
      defaultTab: $('#settings-default-tab').value,
      avatarColor: selectedColor
    };
    try {
      const res = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: u.id, ...fields })
      });
      if (!res.ok) throw new Error('save failed');
      auth.user = { ...auth.user, ...fields };
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth.user));
      updateTopbarUser();
      toast('Definições guardadas', 'success');
    } catch (err) {
      showError(err, 'Não foi possível guardar. Tente novamente.');
    } finally {
      btn.disabled = false; btn.textContent = 'Guardar';
    }
  });

  // Surfaces exactly why a test push did or didn't arrive — sendPushToUsers
  // (used for real alerts) is fire-and-forget and only logs failures on the
  // server, which makes "I'm not getting notifications" impossible to
  // debug from the app itself. This calls the same send path but reports
  // per-device results back here instead.
  panel.querySelector('#settings-test-push-btn')?.addEventListener('click', async () => {
    const btn = panel.querySelector('#settings-test-push-btn');
    btn.disabled = true; btn.textContent = 'A enviar…';
    try {
      const result = await apiPatch('/api/push', { userId: u.id });
      console.log('push test result:', result);
      if (result.ok) {
        const okCount = result.devices.filter(d => d.ok).length;
        toast(`Teste enviado (${okCount}/${result.devices.length} dispositivo${result.devices.length !== 1 ? 's' : ''}) — devias recebê-lo agora`, 'success');
      } else if (result.reason) {
        toast(result.reason, 'error');
      } else {
        const firstError = (result.devices || []).find(d => !d.ok);
        toast(firstError ? `Falha ao enviar: ${firstError.error}` : 'Falha ao enviar notificação de teste', 'error');
      }
    } catch (err) {
      showError(err, 'Não foi possível enviar a notificação de teste');
    } finally {
      btn.disabled = false; btn.textContent = 'Enviar notificação de teste';
    }
  });

  // "Simular alerta" — tests the REAL recipient-resolution path
  // (getNotifyRecipientUserIds, driven by the Settings checkboxes above)
  // instead of always targeting whoever clicked the button. Lets an admin
  // tell, from one tap, whether "test push works but real alerts don't"
  // is because nobody is actually opted in vs. something failing in the
  // send itself.
  const wireSimulateButton = (id, kind, label) => {
    const btn = panel.querySelector(`#${id}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'A simular…';
      try {
        const result = await apiPatch('/api/push', { kind });
        console.log(`push simulate (${kind}) result:`, result);
        if (result.reason) {
          toast(result.reason, result.ok ? 'success' : 'error');
        } else if (result.ok) {
          const okCount = result.devices.filter(d => d.ok).length;
          const names = (result.recipients || []).join(', ');
          toast(`Alerta chegaria a: ${names} (${okCount}/${result.devices.length} dispositivo${result.devices.length !== 1 ? 's' : ''} recebeu agora)`, 'success');
        } else {
          const firstError = (result.devices || []).find(d => !d.ok);
          toast(firstError ? `Falha ao enviar a ${firstError.user}: ${firstError.error}` : 'Falha ao simular alerta', 'error');
        }
      } catch (err) {
        showError(err, `Não foi possível simular o alerta de ${label}`);
      } finally {
        btn.disabled = false; btn.textContent = `Simular alerta: ${label}`;
      }
    });
  };
  wireSimulateButton('settings-test-orders-btn', 'orders', 'encomenda enviada');
  wireSimulateButton('settings-test-lowstock-btn', 'lowstock', 'stock baixo');
}

// ═══════════════════════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════════════════════
function renderAdminPanel() {
  const panel = $('#admin-panel');
  if (!panel) return;

  panel.innerHTML = `
    <button class="back-btn" id="admin-back-btn">‹ Voltar</button>

    <div class="admin-section-title">Utilizadores</div>
    <div class="admin-card" id="admin-users-card">${skeletonRows(3)}</div>

    <div class="admin-section-title">Adicionar utilizador</div>
    <div class="admin-card">
      <input class="order-field" id="admin-new-name" placeholder="Nome" />
      <select class="order-field" id="admin-new-role" style="margin-bottom:0">
        <option value="vendedor">🧾 Vendedor</option>
        <option value="armazém">📦 Armazém</option>
        <option value="admin">🔧 Admin</option>
      </select>
      <button class="btn-primary" id="admin-add-user-btn" style="width:100%;margin-top:var(--sp-3)">Adicionar</button>
    </div>

    <div class="admin-section-title">Materiais de portas</div>
    <div class="admin-card" id="admin-materials-card">${skeletonRows(2)}</div>

    <div class="admin-section-title">Sincronização de preços</div>
    <div class="admin-card">
      <p style="font-size:13px;color:var(--t2);margin:0 0 var(--sp-3)">
        Atualiza os preços do catálogo a partir da lista de preços no Google Drive.
      </p>
      <button class="btn-ghost" id="admin-sync-btn" style="width:100%">Sincronizar agora</button>
    </div>
  `;

  // Same reasoning as Settings' back button — Admin is also reachable from
  // the user menu on any screen, so it needs real back navigation instead
  // of always landing on Home.
  panel.querySelector('#admin-back-btn').addEventListener('click', () => history.back());

  panel.querySelector('#admin-add-user-btn').addEventListener('click', async () => {
    const nameInput = $('#admin-new-name');
    const name = nameInput.value.trim();
    if (!name) { toast('Indica um nome', 'error'); return; }
    const role = $('#admin-new-role').value;
    const btn = panel.querySelector('#admin-add-user-btn');
    btn.disabled = true; btn.textContent = 'A adicionar…';
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role })
      });
      if (!res.ok) throw new Error('create failed');
      nameInput.value = '';
      toast('Utilizador adicionado', 'success');
      loadAdminUsers();
    } catch (err) {
      showError(err, 'Não foi possível adicionar o utilizador.');
    } finally {
      btn.disabled = false; btn.textContent = 'Adicionar';
    }
  });

  panel.querySelector('#admin-sync-btn').addEventListener('click', async () => {
    const btn = panel.querySelector('#admin-sync-btn');
    btn.disabled = true; btn.textContent = 'A sincronizar…';
    try {
      const res = await fetch('/api/sync-prices', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'sync failed');
      const changed = data.summary?.changed ?? 0;
      toast(`Sincronização concluída (${changed} preço${changed !== 1 ? 's' : ''} atualizado${changed !== 1 ? 's' : ''})`, 'success');
    } catch (err) {
      showError(err, 'Não foi possível sincronizar os preços.');
    } finally {
      btn.disabled = false; btn.textContent = 'Sincronizar agora';
    }
  });

  loadAdminUsers();
  loadAdminMaterials();
}

async function loadAdminUsers() {
  const card = $('#admin-users-card');
  if (!card) return;
  try {
    const res = await fetch('/api/users?all=true');
    const data = await res.json();
    const users = data.users || [];

    if (users.length === 0) {
      card.innerHTML = `<div class="home-empty">Sem utilizadores</div>`;
      return;
    }

    card.innerHTML = users.map(u => `
      <div class="admin-user-row" data-id="${u.id}">
        <div class="admin-user-row__top">
          <div class="admin-user-row__avatar" style="${u.avatarColor ? `background:${u.avatarColor}` : ''}">${u.name.charAt(0).toUpperCase()}</div>
          <div style="flex:1">
            <div class="admin-user-row__name">${u.name}</div>
            <div class="admin-user-row__meta">${u.email || 'sem email'}</div>
          </div>
          <label class="admin-user-row__ativo">
            Ativo
            <input type="checkbox" class="admin-user-ativo" ${u.ativo ? 'checked' : ''} ${u.id === auth.user?.id ? 'disabled' : ''} />
          </label>
        </div>
        <div class="admin-user-row__fields">
          <select class="order-field admin-user-role">
            <option value="vendedor" ${u.role === 'vendedor' ? 'selected' : ''}>🧾 Vendedor</option>
            <option value="armazém" ${u.role === 'armazém' ? 'selected' : ''}>📦 Armazém</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>🔧 Admin</option>
          </select>
          <input class="order-field admin-user-email" type="email" placeholder="email" value="${u.email || ''}" />
        </div>
        <button class="btn-ghost admin-user-save-btn" style="width:100%">Guardar</button>
      </div>
    `).join('');

    card.querySelectorAll('.admin-user-row').forEach(row => {
      const id = row.dataset.id;
      row.querySelector('.admin-user-save-btn').addEventListener('click', async () => {
        const btn = row.querySelector('.admin-user-save-btn');
        const fields = {
          role: row.querySelector('.admin-user-role').value,
          ativo: row.querySelector('.admin-user-ativo').checked,
          email: row.querySelector('.admin-user-email').value.trim()
        };
        btn.disabled = true; btn.textContent = 'A guardar…';
        try {
          const res = await fetch('/api/users', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, ...fields })
          });
          if (!res.ok) throw new Error('update failed');
          toast('Utilizador atualizado', 'success');
          if (id === auth.user?.id) {
            auth.user = { ...auth.user, ...fields };
            localStorage.setItem(AUTH_KEY, JSON.stringify(auth.user));
          }
        } catch (err) {
          showError(err, 'Não foi possível guardar as alterações.');
        } finally {
          btn.disabled = false; btn.textContent = 'Guardar';
        }
      });
    });
  } catch (err) {
    card.innerHTML = `<div class="home-empty" style="color:var(--danger)">Erro ao carregar utilizadores</div>`;
  }
}

async function loadAdminMaterials() {
  const card = $('#admin-materials-card');
  if (!card) return;
  try {
    const res = await fetch('/api/door-materials');
    const data = await res.json();
    renderMaterialsList(data.materials || []);
  } catch (err) {
    card.innerHTML = `<div class="home-empty" style="color:var(--danger)">Erro ao carregar materiais</div>`;
  }
}

function renderMaterialsList(materials) {
  const card = $('#admin-materials-card');
  if (!card) return;

  card.innerHTML = `
    <div class="admin-materials-list" id="admin-materials-list">
      ${materials.map(m => `
        <div class="admin-material-row">
          <input class="order-field" value="${m}" />
          <button type="button" class="admin-material-row__remove" aria-label="Remover">×</button>
        </div>
      `).join('')}
    </div>
    <div class="admin-add-row" style="display:flex;gap:var(--sp-2)">
      <input class="order-field" id="admin-new-material" placeholder="Novo material" style="flex:1;margin-bottom:0" />
      <button class="btn-ghost" id="admin-add-material-btn" type="button">+</button>
    </div>
    <button class="btn-primary" id="admin-save-materials-btn" style="width:100%;margin-top:var(--sp-3)">Guardar lista</button>
  `;

  function wireRemove(btn) {
    btn.addEventListener('click', () => btn.closest('.admin-material-row').remove());
  }
  card.querySelectorAll('.admin-material-row__remove').forEach(wireRemove);

  card.querySelector('#admin-add-material-btn').addEventListener('click', () => {
    const input = $('#admin-new-material');
    const value = input.value.trim();
    if (!value) return;
    const list = $('#admin-materials-list');
    const row = document.createElement('div');
    row.className = 'admin-material-row';
    row.innerHTML = `<input class="order-field" value="${value}" /><button type="button" class="admin-material-row__remove" aria-label="Remover">×</button>`;
    list.appendChild(row);
    wireRemove(row.querySelector('.admin-material-row__remove'));
    input.value = '';
    input.focus();
  });

  card.querySelector('#admin-save-materials-btn').addEventListener('click', async () => {
    const btn = card.querySelector('#admin-save-materials-btn');
    const values = Array.from(card.querySelectorAll('.admin-material-row input')).map(i => i.value.trim()).filter(Boolean);
    btn.disabled = true; btn.textContent = 'A guardar…';
    try {
      const res = await fetch('/api/door-materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materials: values })
      });
      if (!res.ok) throw new Error('save failed');
      toast('Lista de materiais guardada', 'success');
    } catch (err) {
      showError(err, 'Não foi possível guardar a lista de materiais.');
    } finally {
      btn.disabled = false; btn.textContent = 'Guardar lista';
    }
  });
}

// Switches to a tab-bar view and kicks off whatever data load that screen
// needs — shared by the tab-bar click handler and applyLandingTab(), so
// jumping to a tab at startup behaves exactly like the user clicking it
// themselves. Pass instant: true to skip the slide animation (used for the
// startup landing-tab jump — animating away from the hardcoded Scan screen
// the instant the app opens just draws attention to it instead of hiding it).
function activateTab(target, { instant = false } = {}) {
  const direction = instant ? 'instant' : undefined;
  setView(target, { direction });
  if (target === 'browse') renderBrowseList($('#browse-search')?.value || '');
  if (target === 'orders') {
    renderOrdersList();
    loadOrders({ silent: true }).then(() => renderOrdersList());
  }
  if (target === 'recursos') {
    if (auth.isWarehouse()) { setView('scan', { pushHistory: false, direction }); return; }
    renderResourcesPanel();
  }
  if (target === 'viaturas') renderViaturasPanel();
  if (target === 'home') {
    renderHome();
    Promise.all([loadOrders({ silent: true }), loadAllItems()]).then(() => renderHome());
  }
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
function init() {
  // Tab bar
  $$('.tabbar__btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.goto));
  });

  // Delegated once here, instead of per-card in renderOrdersList, so
  // re-rendering the list never re-attaches listeners.
  $('#orders-list')?.addEventListener('click', e => {
    const card = e.target.closest('.order-card');
    if (!card) return;
    openOrderDetail(card.dataset.orderId);
  });

  // Home dashboard: recent-order cards behave like the Orders tab, and
  // low-stock rows behave like the Inventário tab — same delegation
  // pattern as those two, just scoped to #home-panel.
  $('#home-panel')?.addEventListener('click', e => {
    const card = e.target.closest('.order-card');
    if (card) { openOrderDetail(card.dataset.orderId); return; }
    const row = e.target.closest('.browse-row');
    if (row) {
      const item = state.items.find(i => i.sku === row.dataset.sku);
      if (!item) return;
      setView('item');
      renderItemDetail(item);
    }
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
  $('#browse-search')?.addEventListener('input', debounce(e => renderBrowseList(e.target.value), 120));

  // Delegated once here, instead of per-row in renderBrowseList, so
  // re-rendering the list on every keystroke never re-attaches listeners.
  $('#browse-list')?.addEventListener('click', e => {
    const row = e.target.closest('.browse-row');
    if (!row) return;
    const item = state.items.find(i => i.sku === row.dataset.sku);
    if (!item) return;
    setView('item');
    renderItemDetail(item);
  });

  // Refresh — reloads both items and orders regardless of which screen is
  // open. loadAllItems/loadOrders each re-render whatever screen depends
  // on their data (see refreshVisibleItemViews/refreshVisibleOrderViews),
  // so this single button fixes stale values everywhere instead of only
  // on the inventory list.
  $('#refresh-btn')?.addEventListener('click', async () => {
    $('#refresh-btn').classList.add('spinning');
    await Promise.all([loadAllItems(), loadOrders()]);
    setTimeout(() => $('#refresh-btn').classList.remove('spinning'), 400);
  });

  // Pull-to-refresh prevention — only kicks in when the thing actually
  // under the finger has nowhere left to scroll upward. This used to
  // always check the current tab's outer .view element, which was fine
  // as long as every scrollable area WAS that .view — but overlays like
  // the Recursos PDF viewer (public/resources.js) scroll their own nested
  // container instead, and that container's scrollTop has nothing to do
  // with the (permanently 0) outer view's. Checking the outer view there
  // made this guard fire on every downward drag inside the PDF viewer
  // once it was scrolled down at all, which blocked scrolling back up —
  // it looked like the page was "stuck" at the bottom. Walking up from
  // the actual touch target to the nearest scrollable ancestor fixes this
  // PDF viewer and any future nested scroll area the same way.
  function nearestScrollableAncestor(el) {
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.querySelector(`.view[data-view="${currentViewName}"]`);
  }

  let touchStartY = 0;
  document.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchmove', e => {
    const scrollable = nearestScrollableAncestor(e.target);
    if (!scrollable) return;
    if (e.touches[0].clientY > touchStartY && scrollable.scrollTop <= 0) e.preventDefault();
  }, { passive: false });

  // Auth init
  loadSavedAuth();

  // Topbar user menu — tapping the pill opens a small dropdown (Definições
  // / Admin / Sair) instead of jumping straight to a logout confirm.
  const userMenu = $('#user-menu');
  function closeUserMenu() { if (userMenu) userMenu.dataset.open = 'false'; }
  $('#user-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    if (!userMenu) return;
    userMenu.dataset.open = userMenu.dataset.open === 'true' ? 'false' : 'true';
  });
  document.addEventListener('click', e => {
    if (userMenu && userMenu.dataset.open === 'true' && !userMenu.contains(e.target) && e.target.id !== 'user-btn') {
      closeUserMenu();
    }
  });
  $('#settings-menu-item')?.addEventListener('click', () => {
    closeUserMenu();
    renderSettings();
    setView('settings');
  });
  $('#admin-menu-item')?.addEventListener('click', () => {
    closeUserMenu();
    setView('admin');
    renderAdminPanel();
  });
  $('#logout-menu-item')?.addEventListener('click', () => {
    closeUserMenu();
    if (confirm(`Sair como ${auth.user?.name}?`)) clearAuth();
  });

  if (auth.user) {
    const overlay = $('#login-overlay');
    if (overlay) overlay.style.display = 'none';
    updateTopbarUser();
    applyRoleRestrictions();
    loadItemsFromCache();
    loadAllItems();
    loadOrders({ silent: true }).then(() => renderOrdersList());
    // Not gated behind the orders load above — this is the common case
    // (an already-logged-in session resuming, i.e. just reopening the
    // app), so waiting on that network round-trip before leaving the
    // hardcoded Scan screen turned every app open into a visible
    // Scan → landing-tab flash/slide. activateTab() (called inside
    // applyLandingTab) loads whatever data the actual landing tab needs
    // on its own, same as a manual tab click would.
    applyLandingTab();
    ensurePushPermissionPrompt();
  } else {
    showLoginScreen();
  }

  // History
  viewHistory.push('scan');
  history.replaceState({ view: 'scan' }, '', '');

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW:', err));
    // A notification tap while the app is already open focuses the
    // existing window instead of reloading it, so it never sees the
    // "?push=..." query string the service worker opened/navigated to —
    // it posts the target here instead. See notificationclick in sw.js.
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'push-navigate' || !event.data.url) return;
      try {
        const push = new URL(event.data.url, location.origin).searchParams.get('push');
        navigateToPushTargetString(push);
      } catch (err) {
        console.error('push navigate failed:', err);
      }
    });
  }

  // Background refresh — stock changed by OTHER people (e.g. Bruno in the
  // warehouse), an order edited directly in the sheet, or a status changed
  // by another salesperson all need to show up without anyone having to
  // hit the manual refresh button or leave and re-enter the screen. Poll
  // both items and orders quietly every 30s; paused while the tab isn't
  // visible, so it doesn't burn requests when the phone is locked or
  // backgrounded.
  const STOCK_POLL_MS = 30000;
  let stockPollTimer = null;
  function startStockPolling() {
    if (stockPollTimer) return;
    stockPollTimer = setInterval(() => {
      if (auth.user && !document.hidden) {
        loadAllItems({ silent: true });
        loadOrders({ silent: true });
      }
    }, STOCK_POLL_MS);
  }
  function stopStockPolling() {
    clearInterval(stockPollTimer);
    stockPollTimer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopStockPolling();
    else {
      loadAllItems({ silent: true });
      loadOrders({ silent: true });
      startStockPolling();
    }
  });
  if (auth.user) startStockPolling();
}

document.addEventListener('DOMContentLoaded', init);
