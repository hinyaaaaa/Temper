/* ============================================================
   Temper service worker（受験向け⑤: 電波が無い場所でも起動できる）
   ------------------------------------------------------------
   方針: 同一オリジンのGETだけを「ネットワーク優先、失敗/遅延時はキャッシュ」
   で扱う。オンラインのときは常に最新のファイルが使われるため、
   index.html と js/*.js が新旧混在するといった事故が起きにくい。
   天気API・Webフォントなど外部オリジンには一切介入しない
   （オフライン時は天気が取れず、フォントは代替書体になるが、
   主機能は動く。憲法11条）。

   CACHE_NAME は app.js の APP_VERSION と合わせて更新すること
   （古いキャッシュはactivate時に削除される）。
   ============================================================ */
const CACHE_NAME = 'temper-shell-v1.7.0';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/app.js',
  './js/planner.js',
  './js/store.js',
  './js/weather.js',
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // 1つ取れなくても全体の導入は失敗させない（addAllは1件の失敗で全滅する）
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('temper-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部オリジンは素通し

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const res = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (e) {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      // ページ遷移だけは、取れなければアプリ本体を返す
      if (req.mode === 'navigate') {
        const shell = (await cache.match('./index.html')) || (await cache.match('./'));
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
