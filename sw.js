/* App shell only. Imported music remains in IndexedDB and is never uploaded. */
'use strict';
const VERSION = '2.1.0';
const CACHE = 'offline-music-shell:' + VERSION;
const SCOPE = self.registration.scope;
const FILES = ['index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'hoyul-music-icon-180-v2.png', 'hoyul-music-icon-192-v2.png', 'hoyul-music-icon-512-v2.png'];
const URLS = FILES.map(path => new URL(path, SCOPE).href);
const HOME = new URL('index.html', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(URLS.map(url => new Request(url, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('offline-music-shell:') && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin || !url.href.startsWith(SCOPE)) return;
  const canonical = url.origin + url.pathname;
  const isHome = request.mode === 'navigate' && (canonical === SCOPE || canonical === HOME);
  if (!isHome && !URLS.includes(canonical)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = isHome ? HOME : canonical;
    const cached = await cache.match(key);
    if (cached) return cached;
    try {
      const response = await fetch(new Request(key, { cache: 'reload' }));
      if (response.ok && response.type !== 'opaque') await cache.put(key, response.clone());
      return response;
    } catch {
      return new Response('오프라인 앱 파일을 찾지 못했습니다. 인터넷 연결 후 다시 열어 주세요.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
