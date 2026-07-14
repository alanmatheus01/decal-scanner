'use strict';

const SHELL_CACHE = 'decal-scanner-shell-v1';
const RUNTIME_CACHE = 'decal-scanner-runtime-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // robots.json: network-first so operators get fresh data, fall back to
  // cache when offline.
  if (url.pathname.endsWith('robots.json')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell: stale-while-revalidate, so operators get a fast load from
  // cache now while the next load picks up any deployed code changes.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request).then((res) => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          });
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // Cross-origin (Tesseract.js CDN assets, wasm, traineddata): cache-first,
  // runtime-cached after the first successful fetch so scanning still works
  // with a flaky connection.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
