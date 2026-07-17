/* 당동 점수판 서비스 워커 — 오프라인 캐시
 * 전략:
 *  - 페이지 이동(navigate): 네트워크 우선, 실패 시 캐시 (수정사항이 빨리 반영되도록)
 *  - 그 외 파일: 캐시 우선 + 백그라운드 갱신 (stale-while-revalidate)
 */
const CACHE = 'dang-score-v42';
const ASSETS = [
  '/Dangdong/', '/Dangdong/index.html',
  '/Dangdong/record/', '/Dangdong/record/index.html',
  '/Dangdong/score/', '/Dangdong/score/index.html',
  '/Dangdong/manifest.json',
  '/Dangdong/icon-192.png', '/Dangdong/icon-512.png', '/Dangdong/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
