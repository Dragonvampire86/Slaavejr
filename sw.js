'use strict';
// Gemmer sidens egne filer, så appen åbner uden net. Vejrdata gemmes af siden selv.
// Hæv versionen ved hver ændring af filerne, så gamle kopier ryddes væk.
const CACHE = 'slaavejr-v7';
const SHELL = [
  './', 'index.html', 'style.css', 'plants.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
  'fonts/im-fell-english-latin-400-normal.woff2', 'fonts/im-fell-english-latin-400-italic.woff2', 'fonts/im-fell-english-sc-latin-400-normal.woff2',
  'fonts/source-serif-4-latin-400-normal.woff2', 'fonts/source-serif-4-latin-400-italic.woff2', 'fonts/source-serif-4-latin-600-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Egne filer: vis den gemte kopi med det samme og hent en ny i baggrunden.
// Andre adresser (vejrtjenesten) går altid direkte til nettet.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(res => {
      if (res.ok && res.type === 'basic') cache.put(e.request, res.clone());
      return res;
    }).catch(() => hit);
    if (hit) { try { e.waitUntil(fresh); } catch (err) { /* baggrundsopdatering er valgfri */ } return hit; }
    return fresh;
  }));
});
