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

  // robots.json lives on a different (private, Tailscale-only) origin.
  // Deliberately NOT intercepted here: Chrome's Private Network Access
  // check can only be granted in a page-level fetch context, not from
  // inside a service worker's background fetch (there's no UI to prompt
  // through), so proxying this through the SW gets it silently denied even
  // with the right CORS headers. Not calling respondWith() lets the
  // browser handle it exactly as if the page had called fetch() directly,
  // with no SW involved -- this does mean no offline cache fallback for
  // robots.json specifically; app.js's own fetch already uses
  // cache: 'no-store', so this doesn't change its network-first behavior.
  if (url.pathname.endsWith('robots.json')) {
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
