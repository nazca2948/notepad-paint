// メモ帳PWA用 Service Worker
// ネットワークを優先して常に最新版を読み込み、
// オフラインの時だけ最後に取得できたキャッシュにフォールバックします。
// これにより index.html だけ更新すれば、次回アクセス時に自動で反映されます。

const CACHE_NAME = 'memo-notepad-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ネットワーク優先：取得できたら常にそれを使い、キャッシュも更新しておく。
// オフライン等で取得できない場合だけ、キャッシュにあるものを返す。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
