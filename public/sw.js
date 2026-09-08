// Service worker: network-first strategy for all app files so updates
// are always picked up immediately after a deploy. Falls back to cache
// only when the network is genuinely unavailable (warehouse wifi outage).
// API calls are never cached — stock and price must always be live.
//
// Safari (notably Private Browsing) doesn't expose the Cache Storage API
// inside the service worker at all — `caches` is simply undefined there,
// which throws a ReferenceError the moment it's touched and breaks every
// single fetch. Everything below checks for it first and just falls back
// to a plain network fetch (no offline caching) when it's missing, rather
// than crashing the whole page.

const CACHE_NAME = 'armazem-shell-v3';
const SHELL_FILES = ['/', '/index.html', '/manifest.json', '/app.css', '/app.js', '/jsQR.js'];
const hasCacheStorage = typeof caches !== 'undefined';

self.addEventListener('install', (event) => {
  if (hasCacheStorage) {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
    );
  }
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  if (hasCacheStorage) {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
        .catch(() => {})
    );
  }
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls.
  if (url.pathname.startsWith('/api/')) return;

  if (!hasCacheStorage) {
    // No Cache Storage available (e.g. Safari Private Browsing) — just
    // let the request go straight to the network with no offline fallback.
    return;
  }

  // Network-first: always try the network, fall back to cache only
  // if the network fails. This means updates show up immediately after
  // a deploy without needing to clear cookies/storage.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache a fresh copy for offline fallback
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ─── Web Push ──────────────────────────────────────────────────────────
// The server (lib/push.js) sends a JSON payload like
// { title, body, tag, url }. Low-stock alerts and order-sent notifications
// both go through this same handler — there's nothing order/SKU-specific
// to branch on here, just show it. `url` (e.g. "/?push=order:ENC-123" or
// "/?push=item:01100101") is carried through as notification data so
// notificationclick below can send the app straight there.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  const title = data.title || 'Cedriambar';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// The app has no URL-based view routing (every screen lives at "/"), so
// deep-linking works by carrying a "?push=order:ID" / "?push=item:SKU"
// query string instead of a real path:
//   - No app window open yet: openWindow(targetUrl) — app.js reads
//     location.search on boot (applyPendingPushTarget) and navigates once
//     login/data-loading finishes.
//   - A window is already open: focusing it doesn't reload the page (so
//     the query string would never be read), so we also postMessage the
//     target and app.js's message listener navigates in place.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) {
          client.postMessage({ type: 'push-navigate', url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
