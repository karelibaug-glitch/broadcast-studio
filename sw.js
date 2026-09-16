const CACHE_NAME = 'broadcast-studio-v3';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './index_v2.html',
  './switcher.html',
  './guest.html',
  './director_suite.html',
  './graphics.html',
  './ai_audio.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './css/tailwind.min.css',
  './js/peerjs.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('Some static assets failed to cache:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // Never hijack or fallback dedicated standalone pages, APIs, or room links to index.html
  if (
    url.includes('guest.html') ||
    url.includes('director_suite.html') ||
    url.includes('switcher.html') ||
    url.includes('graphics.html') ||
    url.includes('ai_audio.html') ||
    url.includes('/api/') ||
    url.includes('/ws') ||
    url.includes('room=')
  ) {
    event.respondWith(fetch(event.request).catch(err => caches.match(event.request)));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).catch(() => {
        // Only return index.html if navigating to the root index
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('Network error', { status: 408, headers: { 'Content-Type': 'text/plain' } });
      });
    })
  );
});

