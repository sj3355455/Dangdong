-- ═══════════════════════════════════════════════════════════════
-- 관리자 메뉴 — 누가 알림을 켰고 누가 껐나
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
-- admin-setup.sql(is_admin 함수)과 push-subscriptions-beta.sql 이 먼저 돌아 있어야 합니다.
--
-- 구독 표(push_subscriptions_beta)는 각자 자기 행만 볼 수 있게 잠겨 있다. 관리자도 예외가 아니다.
-- 그래서 관리자 확인을 거친 이 함수로만 전체를 본다.
-- endpoint(그 기기로 알림을 쏠 수 있는 주소)는 돌려주지 않는다 — 기기 종류·앱·켠 날짜만 준다.
--
-- '켬' = 서버에 그 사람 계정의 구독이 남아 있다는 뜻이다. 폰 설정에서 알림을 막았거나 앱을 지운 경우
-- 다음에 알림을 보내 실패할 때(410) 정리되기 전까지는 여전히 '켬'으로 보인다 → 테스트 알림으로 확인한다.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.admin_push_status()
returns table(
  user_id      uuid,
  display_name text,
  devices      jsonb      -- [{label, beta, since}] 오래된 것부터. 알림을 껐으면 빈 배열
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_authorized';
  end if;

  return query
  select p.id, p.display_name,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'label', s.label,
                    'beta',  coalesce(s.scope, '') like '%-beta%',
                    'since', s.created_at
                  ) order by s.created_at)
           from public.push_subscriptions_beta s
           where s.user_id = p.id
         ), '[]'::jsonb)
  from public.profiles p
  order by p.display_name;
end;
$$;
grant execute on function public.admin_push_status() to authenticated;

notify pgrst, 'reload schema';
