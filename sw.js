// Cache-first service worker: the whole app is precached on install so it
// runs offline after the first visit.
const VERSION = 'meridian-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/config.js',
  './src/physics.js',
  './src/orbit.js',
  './src/vehicle.js',
  './src/sim.js',
  './src/scene.js',
  './src/planettex.js',
  './src/controls.js',
  './src/hud.js',
  './src/navball.js',
  './src/audio.js',
  './src/craft.js',
  './src/vab.js',
  './vendor/three.module.min.js',
  './vendor/three.core.min.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        throw new Error('offline and uncached');
      });
    }),
  );
});
