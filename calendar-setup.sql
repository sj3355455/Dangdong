-- ═══════════════════════════════════════════════════════════════
-- 당동 앱 캘린더 — 정기전 일정 + 참여 익명 투표
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- teams-setup.sql / teams-rls.sql 을 먼저 실행한 뒤에 돌려야 합니다.
-- 여러 번 실행해도 안전합니다 (멱등).
--
-- 익명성을 어떻게 지키는가:
--   day_votes 는 "내 표만 SELECT" 정책이라, 클라이언트는 남의 표를 아예 읽을 수 없다.
--   화면에 보이는 O/X 인원수는 집계 함수(vote_counts)가 서버에서 세어 숫자만 돌려준다.
--   즉 누가 무엇을 골랐는지는 앱 어디에서도 조회할 방법이 없다.
--   (표를 지우거나 바꾸는 것도 본인 것만 가능)
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 0-0) 선행 조건 검사
--   SQL Editor 는 스크립트 전체를 한 트랜잭션으로 돌린다. 뒤쪽에서 실패하면 앞에서
--   만든 것까지 전부 롤백되어 "아무것도 안 생겼는데 이유는 모르겠는" 상태가 된다.
--   그래서 의존하는 것들이 있는지 먼저 확인하고, 없으면 읽을 수 있는 문구로 멈춘다.
-- ─────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.teams') is null or to_regclass('public.team_members') is null then
    raise exception '먼저 teams-setup.sql 을 실행해 주세요. (teams / team_members 테이블이 없습니다)';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'profiles 테이블이 없습니다. 기본 스키마부터 확인해 주세요.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_member_of'
  ) then
    raise exception '먼저 teams-rls.sql 을 실행해 주세요. (is_member_of 함수가 없습니다)';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 0) 팀 관리자 판별 (RLS 안에서 재귀 없이 쓰려고 SECURITY DEFINER)
--    is_member_of 는 teams-rls.sql 에서 이미 만들어 둔 것을 그대로 쓴다.
-- ─────────────────────────────────────────────────────────────
create or replace function public.is_team_admin(t uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.team_members
    where team_id = t and user_id = auth.uid() and is_admin
  )
$$;

-- ─────────────────────────────────────────────────────────────
-- 1) 정기전 — 관리자가 "이 날이 몇 회 정기전"인지 직접 지정
-- ─────────────────────────────────────────────────────────────
create table if not exists public.club_events (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams(id) on delete cascade,
  event_date date not null,
  round_no   int,                 -- 회차. 번호를 안 매기는 모임이면 null
  note       text,                -- 짧은 메모 (장소 등). 선택
  created_at timestamptz not null default now(),
  unique (team_id, event_date)    -- 하루에 정기전 하나
);
create index if not exists club_events_team_date_idx
  on public.club_events(team_id, event_date);

-- ─────────────────────────────────────────────────────────────
-- 2) 참여 투표 — 부원이 날짜마다 O(가능) / X(불가) 를 남긴다
-- ─────────────────────────────────────────────────────────────
create table if not exists public.day_votes (
  team_id    uuid not null references public.teams(id) on delete cascade,
  vote_date  date not null,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  choice     text not null check (choice in ('o','x')),
  updated_at timestamptz not null default now(),
  primary key (team_id, vote_date, user_id)
);
create index if not exists day_votes_team_date_idx
  on public.day_votes(team_id, vote_date);

-- ─────────────────────────────────────────────────────────────
-- 3) 권한 + RLS
-- ─────────────────────────────────────────────────────────────
grant select, insert, update, delete on public.club_events to authenticated;
grant select, insert, update, delete on public.day_votes  to authenticated;

alter table public.club_events enable row level security;
alter table public.day_votes  enable row level security;

-- 정기전: 팀원이면 읽고, 팀 관리자만 쓴다
drop policy if exists "read team events"   on public.club_events;
drop policy if exists "admin add event"    on public.club_events;
drop policy if exists "admin edit event"   on public.club_events;
drop policy if exists "admin drop event"   on public.club_events;

create policy "read team events" on public.club_events
  for select using (public.is_member_of(team_id));
create policy "admin add event" on public.club_events
  for insert with check (public.is_team_admin(team_id));
create policy "admin edit event" on public.club_events
  for update using (public.is_team_admin(team_id))
       with check (public.is_team_admin(team_id));
create policy "admin drop event" on public.club_events
  for delete using (public.is_team_admin(team_id));

-- 투표: 오직 '내 표'만. 남의 표는 조회 자체가 불가능하다 → 익명 보장.
drop policy if exists "read own vote"   on public.day_votes;
drop policy if exists "add own vote"    on public.day_votes;
drop policy if exists "edit own vote"   on public.day_votes;
drop policy if exists "drop own vote"   on public.day_votes;

create policy "read own vote" on public.day_votes
  for select using (user_id = auth.uid());
create policy "add own vote" on public.day_votes
  for insert with check (user_id = auth.uid() and public.is_member_of(team_id));
create policy "edit own vote" on public.day_votes
  for update using (user_id = auth.uid())
       with check (user_id = auth.uid() and public.is_member_of(team_id));
create policy "drop own vote" on public.day_votes
  for delete using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- 4) 집계 — 날짜별 O/X 인원수만 돌려준다 (누가 골랐는지는 나가지 않는다)
--    SECURITY DEFINER 라 RLS를 우회하므로, 팀원인지는 함수 안에서 직접 확인한다.
-- ─────────────────────────────────────────────────────────────
create or replace function public.vote_counts(t uuid, d1 date, d2 date)
returns table(vote_date date, o_cnt integer, x_cnt integer)
language sql
stable
security definer
set search_path = public
as $$
  select v.vote_date,
         (count(*) filter (where v.choice = 'o'))::integer,
         (count(*) filter (where v.choice = 'x'))::integer
  from public.day_votes v
  where v.team_id = t
    and v.vote_date >= d1
    and v.vote_date <= d2
    and public.is_member_of(t)     -- 팀원이 아니면 빈 결과
  group by v.vote_date
$$;
grant execute on function public.vote_counts(uuid, date, date) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 4-1) PostgREST 스키마 캐시 갱신
--   함수를 새로 만들어도 API 쪽 캐시가 갱신되기 전에는 /rest/v1/rpc/vote_counts 가
--   404 로 떨어진다. 그러면 "내 표는 저장되는데 남의 표가 안 보이는" 증상이 된다.
--   (앱은 이 실패를 화면에 그대로 표시한다)
-- ─────────────────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────
-- 5) 자체 점검 — 다 만들어졌는지 여기서 확인하고 끝낸다.
--    실행 결과에 '캘린더 설치 완료' 가 보이면 정상이다.
--    (앱에서 계속 404 가 나면 스키마 캐시 문제이니 위 notify 만 다시 실행해 보세요)
-- ─────────────────────────────────────────────────────────────
do $$
declare missing text := '';
begin
  if to_regclass('public.club_events') is null then missing := missing || ' club_events'; end if;
  if to_regclass('public.day_votes')  is null then missing := missing || ' day_votes';  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'vote_counts')
    then missing := missing || ' vote_counts'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_team_admin')
    then missing := missing || ' is_team_admin'; end if;

  if missing <> '' then
    raise exception '설치가 덜 됐습니다. 빠진 것:%', missing;
  end if;
  raise notice '캘린더 설치 완료 — club_events / day_votes / vote_counts / is_team_admin 모두 확인';
end $$;

-- 설치 후 확인 쿼리 (선택)
-- select p.proname, pg_get_function_arguments(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('vote_counts','is_member_of','is_team_admin');
-- SQL Editor 는 service_role 이라 RLS 를 우회합니다. 익명성 검증은 앱에서 하세요.
-- ═══════════════════════════════════════════════════════════════
