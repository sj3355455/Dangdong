-- ═══════════════════════════════════════════════════════════════
-- 당동 앱 방문 기록 — 관리자 메뉴의 '방문 기록'(누가 몇 번 들어왔나)
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
-- admin-setup.sql(is_admin 함수)이 먼저 돌아 있어야 합니다.
--
-- '한 번 들어옴'의 뜻: 30분 넘게 안 쓰다가 앱을 다시 연 것. 새로고침하거나 점수판·기록실·캘린더를
--   오가는 건 세지 않는다 — 그 판단은 앱(record/common.js 의 logVisit)이 하고, 서버는 받아 적기만 한다.
-- 로그인한 사람만 센다. 로그인 전 방문은 누군지 알 수 없어 적지 않는다.
-- 기록은 이 SQL 을 실행하고 앱이 배포된 뒤부터 쌓인다 — 그 전 방문은 남아 있지 않다.
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.app_visits (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  app        text not null,                 -- 처음 연 화면: score / record / calendar
  beta       boolean not null default false, -- 테스트 앱에서 들어왔는지
  visited_at timestamptz not null default now()
);
create index if not exists app_visits_time_idx on public.app_visits (visited_at desc);
create index if not exists app_visits_user_idx on public.app_visits (user_id, visited_at desc);

-- 표는 아무에게도 직접 열지 않는다. 쓰기·읽기 모두 아래 두 함수로만 한다.
--   · 직접 insert 를 열면 남의 user_id 로 방문을 지어낼 수 있다 → 함수가 auth.uid() 로 채운다.
--   · 누가 언제 들어왔는지는 관리자만 본다.
alter table public.app_visits enable row level security;
revoke all on public.app_visits from anon, authenticated;

-- 1) 방문 적기 — 앱이 부른다. 로그인 안 했으면 조용히 아무것도 안 한다.
create or replace function public.log_visit(p_app text, p_beta boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  if p_app not in ('score', 'record', 'calendar') then return; end if;
  insert into public.app_visits (user_id, app, beta) values (auth.uid(), p_app, coalesce(p_beta, false));
end;
$$;
grant execute on function public.log_visit(text, boolean) to authenticated;

-- 2) 사람별 방문 수 — 관리자 메뉴가 부른다.
--    p_days 가 null 이면 전체 기간. visits 는 그 기간, total 은 전체 기간 방문 수.
create or replace function public.admin_visit_stats(p_days integer default null)
returns table(
  user_id      uuid,
  display_name text,
  visits       bigint,
  total        bigint,
  last_visit   timestamptz
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not_authorized';
  end if;

  return query
  select p.id, p.display_name,
         count(v.id) filter (where p_days is null or v.visited_at >= now() - make_interval(days => p_days)),
         count(v.id),
         max(v.visited_at)
  from public.profiles p
  left join public.app_visits v on v.user_id = p.id
  group by p.id, p.display_name
  order by 3 desc, 5 desc nulls last, p.display_name;
end;
$$;
grant execute on function public.admin_visit_stats(integer) to authenticated;

notify pgrst, 'reload schema';

-- 확인용: 최근 방문 20건
--   select p.display_name, v.app, v.beta, v.visited_at
--   from app_visits v join profiles p on p.id = v.user_id order by v.visited_at desc limit 20;
