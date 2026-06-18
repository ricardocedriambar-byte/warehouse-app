// Minimal service worker: caches the app shell so the UI still loads
// (offline-ish) even with a flaky warehouse wifi signal. Data requests
// to /api/* are NOT cached — stock/price must always be live, never stale.

const CACHE_NAME = 'armazem-shell-v2';
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

  // Never cache API calls — stock and price must reflect live data.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
