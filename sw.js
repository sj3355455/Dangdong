/* 당동 서비스 워커 — 오프라인 캐시 + 무중단 업데이트
 *
 * 버전은 version.json 한 곳에서만 관리한다(여기엔 버전 숫자를 두지 않는다).
 * 캐시 이름도 version.json 을 읽어서 만든다.
 *
 * 전략:
 *  - 페이지/코드(navigate, .html, .js, 디렉터리): 네트워크 우선 → 배포 즉시 반영, 오프라인일 때만 캐시
 *  - 그 외 정적 자산(아이콘·매니페스트): 캐시 우선 + 백그라운드 갱신(stale-while-revalidate)
 *  - version.json: 절대 가로채지 않음(항상 네트워크) → 프런트 킬스위치가 새 배포를 확실히 감지
 *  - Supabase 등 외부 출처: 가로채지 않음(최신 데이터가 캐시에 가려지지 않도록)
 */
const CACHE_PREFIX = 'dangdong-';
const ASSETS = [
  '/Dangdong/', '/Dangdong/index.html',
  '/Dangdong/record/', '/Dangdong/record/index.html', '/Dangdong/record/app.js',
  '/Dangdong/score/', '/Dangdong/score/index.html', '/Dangdong/score/app.js',
  '/Dangdong/manifest.json',
  '/Dangdong/icon-192.png', '/Dangdong/icon-512.png', '/Dangdong/apple-touch-icon.png'
];

// version.json 을 읽어 현재 캐시 이름을 만든다(워커 수명 동안 1회만 조회).
let _cacheNamePromise = null;
function cacheName() {
  if (!_cacheNamePromise) {
    _cacheNamePromise = fetch('./version.json?ts=' + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(v => CACHE_PREFIX + (v && v.version ? v.version : 'unknown'))
      .catch(() => CACHE_PREFIX + 'fallback');
  }
  return _cacheNamePromise;
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(await cacheName());
    // 원자적 addAll 대신 개별 캐싱 — 파일 하나가 실패해도 설치가 통째로 깨지지 않는다.
    await Promise.allSettled(
      ASSETS.map(a => cache.add(new Request(a, { cache: 'reload' })))
    );
    await self.skipWaiting();   // 새 워커 즉시 대기 해제
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = await cacheName();
    const keys = await caches.keys();
    // 현재 버전 외의 옛 캐시는 모두 삭제
    await Promise.all(keys.filter(k => k !== keep).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 외부 출처(Supabase API 등)는 그대로 통과
  if (url.origin !== self.location.origin) return;
  // version.json 은 절대 캐시하지 않는다 — 새 배포 감지의 기준점
  if (url.pathname.endsWith('/version.json')) return;

  const path = url.pathname;
  const isCode = req.mode === 'navigate' || path.endsWith('/') || path.endsWith('.html') || path.endsWith('.js');

  if (isCode) {
    // 네트워크 우선 → 배포 즉시 반영. 오프라인일 때만 캐시 폴백.
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          cacheName().then(n => caches.open(n).then(c => c.put(req, copy))).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/Dangdong/index.html')))
    );
    return;
  }

  // 그 외 정적 자산: 캐시 우선 + 백그라운드 갱신
  e.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            cacheName().then(n => caches.open(n).then(c => c.put(req, copy))).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
