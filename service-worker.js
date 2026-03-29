const MI_BUILD = '23';
const MI_CACHE_NAME = `mi-cache-${MI_BUILD}`;

const MI_ASSETS = [
  './',
  './index.html',
  './styles2.css?v=23',
  './mobile.css?v=23',
  './madness_index.js?v=23',
  './copy.json?v=23',
  './manifest.json?v=23',
  './assets/img/logos/madness-index-home-logo.png',
  './assets/img/logos/mi-app-icon-192.png',
  './assets/img/logos/mi-app-icon-512.png',
  './data/csvs/mi_2026_official.csv'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(MI_CACHE_NAME).then((cache) => cache.addAll(MI_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== MI_CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle normal web GET requests
  if (req.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // For page navigations: network first, then fall back to cached index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // For same-origin static assets/data: cache first, then network, no HTML fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;

        return fetch(req).then((response) => {
          // Only cache successful basic responses
          if (
            response &&
            response.status === 200 &&
            response.type === 'basic'
          ) {
            const clone = response.clone();
            caches.open(MI_CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Ignore cross-origin requests entirely
});