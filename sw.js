/* Build replaces this cache key with a content hash, so releases stay coherent. */
const CACHE = 'life-in-progress-source-v1';
const FILES = ['./', './index.html', './styles.css', './app.js', './state.js', './gestures.js', './assets/guide-data.js', './favicon.svg', './manifest.webmanifest', './CONTENT-LICENSE.txt'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('life-in-progress-') && name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).catch(error => {
    if (event.request.mode === 'navigate') return caches.match(new URL('./index.html', self.registration.scope));
    throw error;
  })));
});
