// Service worker: network-first strategy for all app files so updates
// are always picked up immediately after a deploy. Falls back to cache
// only when the network is genuinely unavailable (warehouse wifi outage).
// API calls are never cached — stock and price must always be live.

const CACHE_NAME = 'armazem-shell-v3';
const SHELL_FILES = ['/', '/index.html', '/manifest.json', '/app.css', '/app.js', '/jsQR.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first: always try the network, fall back to cache only
  // if the network fails. This means updates show up immediately after
  // a deploy without needing to clear cookies/storage.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache a fresh copy for offline fallback
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
