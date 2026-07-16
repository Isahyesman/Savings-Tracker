/* ===========================================================
   Savings Tracking System — service-worker.js
   Basic cache-first strategy so PWABuilder/Lighthouse sees a
   valid, installable, offline-capable PWA.
=========================================================== */

const CACHE_NAME = 'savings-tracker-v2';
const CORE_ASSETS = [
  './index.html',
  './admin-login.html',
  './admin-dashboard.html',
  './client-login.html',
  './client-dashboard.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(CORE_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(key){ return key !== CACHE_NAME; })
            .map(function(key){ return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

/* Strategy:
   - HTML/JS/CSS (things you'll keep editing): network-first, falling back
     to cache only when offline. This means updates show up on next reload
     without needing a CACHE_NAME bump every time.
   - Icons/manifest (rarely change): cache-first, since there's no benefit
     to re-fetching them constantly. */
const NETWORK_FIRST_EXTENSIONS = ['.html', '.js', '.css'];

self.addEventListener('fetch', function(event){
  if(event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isNetworkFirst = NETWORK_FIRST_EXTENSIONS.some(ext => url.pathname.endsWith(ext)) || event.request.mode === 'navigate';

  if(isNetworkFirst){
    event.respondWith(
      fetch(event.request).then(function(response){
        if(response && response.status === 200){
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, responseClone); });
        }
        return response;
      }).catch(function(){
        return caches.match(event.request).then(function(cached){
          return cached || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined);
        });
      })
    );
    return;
  }

  // cache-first for everything else (icons, manifest, etc.)
  event.respondWith(
    caches.match(event.request).then(function(cached){
      if(cached) return cached;
      return fetch(event.request).then(function(response){
        if(response && response.status === 200 && response.type === 'basic'){
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, responseClone); });
        }
        return response;
      }).catch(function(){
        if(event.request.mode === 'navigate'){
          return caches.match('./index.html');
        }
      });
    })
  );
});
