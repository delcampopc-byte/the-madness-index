const MI_BUILD = '39';
const MI_CACHE_NAME = `mi-cache-${MI_BUILD}`;

const MI_ASSETS = [
  './',
  './index.html',
  './styles2.css?v=39',
  './mobile.css?v=39',
  './madness_index.js?v=39',
  './copy.json?v=39',
  './manifest.json?v=39',
  './data/branding/team_branding.json?v=39',
  './assets/img/logos/madness-index-home-logo.png',
  './assets/img/logos/mi-app-icon-192.png',
  './assets/img/logos/mi-app-icon-512.png',
  './data/csvs/mi_2016_official.csv',
  './data/csvs/mi_2017_official.csv',
  './data/csvs/mi_2018_official.csv',
  './data/csvs/mi_2019_official.csv',
  './data/csvs/mi_2021_official.csv',
  './data/csvs/mi_2022_official.csv',
  './data/csvs/mi_2023_official.csv',
  './data/csvs/mi_2024_official.csv',
  './data/csvs/mi_2025_official.csv',
  './data/csvs/mi_2026_official.csv'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(MI_CACHE_NAME);
    const results = await Promise.allSettled(
      MI_ASSETS.map(async (asset) => {
        const req = new Request(asset, { cache: 'reload' });
        const res = await fetch(req);
        if (!res.ok) throw new Error(`${asset} -> ${res.status}`);
        await cache.put(req, res.clone());
      })
    );
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length) {
      console.warn('[MI SW] Precache failures:', failures.map(f => f.reason));
    }
    self.skipWaiting(); // ← MOVE IT HERE, inside the waitUntil
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== MI_CACHE_NAME) return caches.delete(key);
        })
      )
    ).then(() => self.clients.claim()) // ← MOVE claim() here, AFTER cache cleanup
  );
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