/* 당동 서비스 워커 — 오프라인 캐시 + 무중단 자동 업데이트
 *
 * ▶ 배포할 때는 아래 VERSION 한 줄만 올리면 된다(예: v170 → v171).
 *   VERSION 이 바뀌면 이 파일 내용이 바뀌므로 브라우저가 "새 워커"로 감지 →
 *   설치(install) → 활성화(activate) → 제어권 교체(controllerchange) 순으로 진행되고,
 *   그 순간 앱이 자동으로 1회 새로고침된다(app.js 의 controllerchange 처리). 폴링 불필요.
 *
 * 전략:
 *  - 코드(navigate/.html/.js): 네트워크 우선 + HTTP 캐시 우회(cache:'reload') → 항상 최신
 *  - 그 외 정적 자산(아이콘·매니페스트): 캐시 우선 + 백그라운드 갱신
 *  - 외부 출처(Supabase API 등): 가로채지 않음
 */
const VERSION = 'v170';
const CACHE = 'dangdong-' + VERSION;
const ASSETS = [
  '/Dangdong/', '/Dangdong/index.html',
  '/Dangdong/record/', '/Dangdong/record/index.html', '/Dangdong/record/app.js',
  '/Dangdong/score/', '/Dangdong/score/index.html', '/Dangdong/score/app.js',
  '/Dangdong/manifest.json',
  '/Dangdong/icon-192.png', '/Dangdong/icon-512.png', '/Dangdong/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 개별 캐싱(allSettled) — 파일 하나가 실패해도 설치가 통째로 깨지지 않는다.
    await Promise.allSettled(ASSETS.map(a => cache.add(new Request(a, { cache: 'reload' }))));
    await self.skipWaiting();   // 새 워커 즉시 대기 해제 → 곧바로 활성화
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));   // 옛 버전 캐시 삭제
    await self.clients.claim();   // 열려 있는 모든 탭 제어 → controllerchange 발생 → 앱이 새로고침
  })());
});

// 페이지가 현재 버전을 물어보면 알려준다(푸터 표시용). 버전 단일 소스 = 이 파일의 VERSION.
self.addEventListener('message', e => {
  if (e.data === 'getVersion' && e.source) e.source.postMessage({ type: 'appVersion', version: VERSION });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // 외부(API)는 통과
  if (url.pathname.endsWith('/version.json')) return;            // 구버전 클라이언트 호환: 항상 네트워크

  const path = url.pathname;
  const isCode = req.mode === 'navigate' || path.endsWith('/') || path.endsWith('.html') || path.endsWith('.js');

  if (isCode) {
    // 네트워크 우선. cache:'reload' 로 브라우저 HTTP 캐시(GitHub Pages max-age=600)를 우회 → 항상 최신 코드.
    e.respondWith(
      fetch(req, { cache: 'reload' })
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res; })
        .catch(() => caches.match(req).then(r => r || caches.match('/Dangdong/index.html')))
    );
    return;
  }

  // 그 외 정적 자산: 캐시 우선 + 백그라운드 갱신
  e.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req)
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); } return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
