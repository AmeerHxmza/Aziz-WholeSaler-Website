// Aziz & Son Wholesale - Resilient Service Worker
const CACHE_NAME = 'aziz-pos-v2';
const STATIC_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/favicon.ico'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Individually add assets with try/catch so a single failure never aborts installation
      for (const url of STATIC_ASSETS) {
        try {
          const res = await fetch(url);
          if (res && res.status === 200) {
            await cache.put(url, res);
          }
        } catch {
          // Ignore prefetch network errors during install
        }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        return Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        );
      })
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests, Supabase API calls, extensions, and dev HMR
  if (
    req.method !== 'GET' ||
    url.origin.includes('supabase.co') ||
    url.protocol.startsWith('chrome-extension') ||
    url.pathname.includes('/_next/webpack-hmr')
  ) {
    return;
  }

  // 1. Navigation requests (HTML pages: /, /sales/.../receipt, etc.)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(async () => {
          // Offline fallback
          const cache = await caches.open(CACHE_NAME);
          const cachedExact = await cache.match(req);
          if (cachedExact) return cachedExact;

          // Fallback to app shell
          const cachedHome = await cache.match('/');
          if (cachedHome) return cachedHome;

          return new Response(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aziz POS Offline</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family:sans-serif;padding:2rem;text-align:center;"><h2>Aziz & Son POS (Offline)</h2><p>Please launch the installed PWA or reload when connection is available.</p><button onclick="window.location.reload()" style="padding:10px 20px;margin-top:10px;cursor:pointer;">Retry</button></body></html>`,
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        })
    );
    return;
  }

  // 2. Static Next.js assets (_next/static, css, js, fonts, images)
  const isStatic =
    url.pathname.startsWith('/_next/static') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.woff2');

  if (isStatic) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              const clone = networkRes.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            }
            return networkRes;
          })
          .catch(() => {
            // Return empty response for missing non-critical assets to avoid unhandled crash
            return new Response('', { status: 404, statusText: 'Not Found Offline' });
          });
      })
    );
    return;
  }

  // 3. Next.js App Router RSC data requests (?_rsc=...)
  if (url.searchParams.has('_rsc')) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response('', { status: 204 });
        })
    );
    return;
  }

  // 4. Default: Stale-while-revalidate or Network with cache fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
