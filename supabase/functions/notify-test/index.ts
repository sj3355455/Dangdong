// 당동 — 관리자 메뉴의 '테스트 알림 보내기'. 알림이 기기까지 제대로 가는지 확인하는 용도다.
//
// 배포 (대시보드에서 다 된다):
//   1) Edge Functions → Deploy a new function → 이름 notify-test → 이 파일 내용 붙여넣기
//   2) Secrets 는 notify-meetup 과 같은 것을 쓴다 (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / APP_URL)
//   Verify JWT 는 켠 채로 둔다 — 로그인한 사람의 토큰으로만 부를 수 있어야 한다.
//   ※ 앱은 /functions/v1/notify-test 로 부른다. 목록의 '이름'이 아니라 URL 끝(slug)이 notify-test 여야 한다 —
//     에디터는 slug 를 자동 이름(예: hyper-worker)으로 붙이고, 만든 뒤에는 바꿀 수 없다.
//
// 누가 부를 수 있나: 사이트 관리자(profiles.is_admin)만. 부른 사람의 토큰으로 is_admin() 을 물어 확인한다.
//   아무나 부를 수 있으면 부원들 폰을 마음대로 울릴 수 있다.
//
// 누구에게 보내나 (body.target):
//   'me'      부른 관리자 본인의 기기 전부 (기본값)
//   'all'     알림을 켜 둔 모든 기기 — 본 앱·테스트 앱, 모든 팀
//   <uuid>    그 회원의 기기 전부
//
// 돌려주는 것: 기기마다 성공/실패를 담은 목록. 어느 기기에서 막혔는지 바로 보이게 하려는 것이다.

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
// 앱의 sbFetch 는 실패 응답에서 message 를 찾아 화면에 띄운다 — 같은 문구를 그 이름으로도 실어 준다
const fail = (message: string, status: number) => json({ error: message, message }, status);

// 알림을 누르면 열릴 앱 주소 — notify-meetup 과 같은 규칙 (구독의 scope 첫 마디가 앱의 뿌리)
function appBase(scope: string | null, fallback: string){
  const m = (scope || '').match(/^\/[^/]+\//);
  return m ? new URL(m[0], fallback).href : fallback;
}

type Sub = { endpoint: string; p256dh: string; auth_key: string; label: string | null;
             scope: string | null; user_id: string | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('POST 만 받습니다', 405);

  const SB_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
               || Deno.env.get('SUPABASE_SECRET_KEY')
               || Deno.env.get('SERVICE_ROLE_KEY');
  const PUB = Deno.env.get('VAPID_PUBLIC_KEY');
  const PRIV = Deno.env.get('VAPID_PRIVATE_KEY');
  const APP_URL = Deno.env.get('APP_URL') || 'https://sj3355455.github.io/Dangdong-beta/';

  if (!PUB || !PRIV) return fail('VAPID 키가 등록되지 않았습니다 (Edge Functions → Secrets)', 500);
  if (!SERVICE) return fail('관리 권한 키를 찾지 못했습니다. Edge Functions → Secrets 에 '
    + 'SERVICE_ROLE_KEY 라는 이름으로 service_role(또는 secret) 키를 등록해 주세요.', 500);

  let target = 'me';
  try { target = (await req.json())?.target || 'me'; } catch { /* 본문 없음 = 나에게 */ }

  // 1) 부른 사람이 관리자인지 — 그 사람의 토큰 그대로 물어본다 (is_admin() 은 auth.uid() 를 본다)
  const asUser = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } }
  });
  const { data: me } = await asUser.auth.getUser();
  if (!me?.user) return fail('로그인이 필요합니다. 다시 로그인해 주세요.', 401);
  const { data: isAdmin, error: admErr } = await asUser.rpc('is_admin');
  if (admErr) return fail('관리자 확인에 실패했습니다: ' + admErr.message, 500);
  if (!isAdmin) return fail('관리자만 테스트 알림을 보낼 수 있습니다.', 403);

  // 2) 보낼 기기 고르기 — 구독 표는 RLS 로 막혀 있어 관리 권한으로 읽는다
  const admin = createClient(SB_URL, SERVICE);
  let q = admin.from('push_subscriptions_beta').select('endpoint, p256dh, auth_key, label, scope, user_id');
  if (target === 'me') q = q.eq('user_id', me.user.id);
  else if (target !== 'all') q = q.eq('user_id', target);
  const { data: subsRaw, error: subErr } = await q;
  if (subErr) return fail('구독 목록을 읽지 못했습니다: ' + subErr.message, 500);
  const subs = (subsRaw || []) as Sub[];
  if (!subs.length) return json({ sent: 0, failed: 0, cleaned: 0, devices: [],
    note: target === 'me'
      ? '내 계정으로 알림을 켠 기기가 없습니다. 설정에서 알림을 먼저 켜 주세요.'
      : '알림을 켠 기기가 없습니다.' });

  // 결과 목록에 이름을 붙이려고 프로필을 한 번에 읽는다
  const ids = [...new Set(subs.map(s => s.user_id).filter(Boolean))] as string[];
  const { data: profs } = ids.length
    ? await admin.from('profiles').select('id, display_name').in('id', ids)
    : { data: [] };
  const nameOf = new Map((profs || []).map((p: { id: string; display_name: string }) => [p.id, p.display_name]));

  const { data: sender } = await admin.from('profiles').select('display_name').eq('id', me.user.id).single();
  const stamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit' })
    .format(new Date());

  webpush.setVapidDetails(APP_URL, PUB, PRIV);

  let sent = 0, failed = 0;
  const gone: string[] = [];
  const devices: Record<string, unknown>[] = [];
  for (const s of subs) {
    const base = appBase(s.scope, APP_URL);
    const row = {
      name: (s.user_id && nameOf.get(s.user_id)) || '(계정 없음)',
      label: s.label || '기기',
      app: (s.scope || '').includes('-beta') ? '테스트 앱' : '본 앱',
      result: 'ok', code: null as number | null
    };
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
        JSON.stringify({
          title: '🔔 당동 테스트 알림',
          body: `알림이 잘 도착했습니다 (${stamp})` + (sender?.display_name ? `\n${sender.display_name}님이 보냄` : ''),
          url: `${base}score/`,
          tag: `test-${Date.now()}`
        })
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode ?? null;
      row.code = code;
      // 404/410 = 앱을 지웠거나 구독이 만료된 기기 → 주소록에서 정리한다 (다른 알림 함수와 같다)
      if (code === 404 || code === 410) { gone.push(s.endpoint); row.result = 'gone'; }
      else { failed++; row.result = 'fail'; }
      console.error('push 실패', s.label, code, e);
    }
    devices.push(row);
  }
  if (gone.length) await admin.from('push_subscriptions_beta').delete().in('endpoint', gone);

  return json({ sent, failed, cleaned: gone.length, devices });
});
