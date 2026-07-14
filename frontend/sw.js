/* =========================================================
   SERVICE WORKER — FX Journal Pro
   Caches only the local static app shell (HTML/CSS/JS/icons).
   Anything else (Supabase auth/API calls, CDN scripts, fonts,
   Chart.js, etc.) is always passed straight through to the
   network and NEVER touched by this worker — this is what
   keeps Supabase auth/session refresh working normally.
   ========================================================= */

const CACHE_NAME = 'fx-journal-v1';

// Paths are relative so this works whether the app is hosted
// at the domain root or under a GitHub Pages subpath.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/supabase-client.js',
  './js/auth.js',
  './js/database.js',
  './js/script.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests for our own origin's app-shell files.
  // Everything else (Supabase, CDNs, fonts, POST/PUT/DELETE, etc.)
  // is left completely alone and goes straight to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Cache-fill same-origin static assets as they're fetched
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
