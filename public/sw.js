/* Generated assets are tied to the current production build. Installation fails
   if any required asset is missing, leaving the previous working cache intact. */
importScripts('/sw-assets.js');
const CACHE_NAME = `aziz-pos-${self.AZIZ_BUILD}`;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll([
    '/', '/manifest.webmanifest', '/icon.svg', '/favicon.ico', ...self.AZIZ_ASSETS
  ])));
});
self.addEventListener('activate', event => {
  // No skipWaiting: the new build activates after all old tabs close.
  event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('aziz-pos-') && key !== CACHE_NAME).map(key => caches.delete(key))))]));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      if (url.pathname === '/') { const shell = await cache.match('/'); if (shell) return shell; }
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return await cache.match(request) || await cache.match('/') || new Response('Offline setup incomplete. Connect once and reload.', { status: 503 });
      }
    })());
  }
});
