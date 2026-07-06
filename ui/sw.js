// Agentic OS Service Worker — network-first (Daten immer frisch), Shell-Fallback offline
const CACHE = 'aos-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon-192.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (e.request.url.endsWith('/')) caches.open(CACHE).then((c) => c.put('/', r.clone()));
        return r.clone();
      })
      .catch(() => caches.match(e.request))
  );
});
