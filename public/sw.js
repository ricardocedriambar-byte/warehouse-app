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
