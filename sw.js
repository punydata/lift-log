// Offline support: keeps a copy of the app's files on the phone.
// Bump VERSION whenever app files change so phones pick up the update.
importScripts('./js/env.js');
const ENV = self.LIFTLOG_ENV;
const VERSION = 'v0.5.4';
const CACHE = ENV.CACHE_PREFIX + VERSION;
const FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/env.js',
  './js/app.js',
  './js/db.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
// The dev copy lives at ./dev/ inside the live copy's address range; live leaves it alone.
const DEV_PATH = new URL('./dev/', self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // Only ever delete this copy's own old caches. Live also clears its pre-v0.5.4 cache names (e.g. "v0.5.3").
  const mine = (k) => k.startsWith(ENV.CACHE_PREFIX) || (ENV.ENV === 'live' && /^v\d/.test(k));
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => mine(k) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates arrive when online), fall back to the saved copy when offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (ENV.ENV === 'live' && url.pathname.startsWith(DEV_PATH)) return;
  event.respondWith(
    // 'no-cache' = always ask the server if there's a newer file (cheap check), so updates arrive right away
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
