-- ═══════════════════════════════════════════════════════════════
-- 당동 앱 캘린더 — 정기전 일정 + 참여 익명 투표
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- teams-setup.sql / teams-rls.sql 을 먼저 실행한 뒤에 돌려야 합니다.
-- 여러 번 실행해도 안전합니다 (멱등).
--
-- 익명성을 어떻게 지키는가:
--   day_votes 는 "내 표만 SELECT" 정책이라, 클라이언트는 남의 표를 아예 읽을 수 없다.
--   화면에 보이는 O/X 인원수는 집계 함수(vote_counts)가 서버에서 세어 숫자만 돌려준다.
--   가능 시간대·불가 사유도 마찬가지로 '몇 명'까지만 집계되어 나간다.
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

-- 2-1) 표에 붙는 부가 정보 (나중에 추가된 열 — 기존 표는 전부 null 이다)
--   from_hour/to_hour : O 일 때 "몇 시부터 몇 시까지 가능한지"  (to_hour 는 끝 시각, 24 = 자정)
--   reason            : X 일 때 "왜 안 되는지" (예: 시험기간). 20자까지.
-- 이 값들도 남에게는 개별로 나가지 않는다 — vote_counts 가 이름 없이 집계해서만 돌려준다.
alter table public.day_votes add column if not exists from_hour smallint;
alter table public.day_votes add column if not exists to_hour   smallint;
alter table public.day_votes add column if not exists reason    text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'day_votes_hours_chk'
                    and conrelid = 'public.day_votes'::regclass) then
    alter table public.day_votes add constraint day_votes_hours_chk check (
      (from_hour is null and to_hour is null)
      or (from_hour between 0 and 23 and to_hour between 1 and 24 and from_hour < to_hour)
    );
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'day_votes_reason_chk'
                    and conrelid = 'public.day_votes'::regclass) then
    alter table public.day_votes add constraint day_votes_reason_chk check (
      reason is null or char_length(reason) <= 20
    );
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 2-2) 개인 일정 — "12~14일은 시험기간이라 안 된다"
--   day_votes 에 사유를 달아 두던 방식은 기본키가 (팀,날짜,사람)이라 하루에 하나뿐이었다.
--   그래서 같은 날 두 번째 일정을 넣으면 첫 일정을 덮어썼다. 일정을 '이름 + 기간' 한 행으로
--   따로 두면 한 사람이 같은 날에 몇 개든 등록할 수 있고, 지우는 것도 행 하나 지우면 끝난다.
--   day_votes 는 그대로 둔다 — 그냥 누르는 O/X 는 여전히 사람당 하루 하나가 맞다.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.day_plans (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  start_date date not null,
  end_date   date not null,
  created_at timestamptz not null default now(),
  constraint day_plans_name_chk  check (char_length(btrim(name)) between 1 and 20),
  constraint day_plans_range_chk check (end_date >= start_date)
);
create index if not exists day_plans_team_range_idx
  on public.day_plans(team_id, start_date, end_date);

-- ─────────────────────────────────────────────────────────────
-- 3) 권한 + RLS
-- ─────────────────────────────────────────────────────────────
grant select, insert, update, delete on public.club_events to authenticated;
grant select, insert, update, delete on public.day_votes  to authenticated;
grant select, insert, update, delete on public.day_plans  to authenticated;

alter table public.club_events enable row level security;
alter table public.day_votes  enable row level security;
alter table public.day_plans  enable row level security;

-- 일정: 표와 똑같이 '내 것'만 읽고 쓴다. 남의 일정은 조회 자체가 불가능하고,
-- 화면에 보이는 막대는 plan_spans 가 이름과 인원수만 집계해서 돌려준 것이다.
drop policy if exists "read own plan" on public.day_plans;
drop policy if exists "add own plan"  on public.day_plans;
drop policy if exists "edit own plan" on public.day_plans;
drop policy if exists "drop own plan" on public.day_plans;

create policy "read own plan" on public.day_plans
  for select using (user_id = auth.uid());
create policy "add own plan" on public.day_plans
  for insert with check (user_id = auth.uid() and public.is_member_of(team_id));
create policy "edit own plan" on public.day_plans
  for update using (user_id = auth.uid())
       with check (user_id = auth.uid() and public.is_member_of(team_id));
create policy "drop own plan" on public.day_plans
  for delete using (user_id = auth.uid());

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
-- 4) 집계 — 날짜별 O/X 인원수 + 시간대별 인원수 + 불가 사유별 인원수.
--    전부 '몇 명'까지만 나간다. user_id 는 이 함수 밖으로 절대 나가지 않으므로
--    시간과 사유를 공개해도 누가 썼는지는 여전히 알 수 없다.
--    SECURITY DEFINER 라 RLS를 우회하므로, 팀원인지는 함수 안에서 직접 확인한다.
--
--    hours   : [[19,4],[20,5]]        → 19시에 4명, 20시에 5명 가능
--    reasons : [["시험기간",3],...]   → 그 사유로 불가인 사람이 3명
--
--    반환 열이 늘어난 것뿐이라 옛 앱(o_cnt/x_cnt 만 읽는)도 그대로 동작한다.
--    다만 반환 타입이 바뀌면 CREATE OR REPLACE 가 막히므로 먼저 지운다.
-- ─────────────────────────────────────────────────────────────
drop function if exists public.vote_counts(uuid, date, date);

create or replace function public.vote_counts(t uuid, d1 date, d2 date)
returns table(vote_date date, o_cnt integer, x_cnt integer, hours jsonb, reasons jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with mem as (select public.is_member_of(t) as ok),   -- 팀원이 아니면 아래가 전부 빈 결과
  -- 등록된 일정을 날짜별로 펼친다. 일정이 걸린 날은 그 사람이 '불가'인 것으로 본다.
  plan_days as (
    select g::date as vote_date, p.user_id, btrim(p.name) as reason
    from public.day_plans p
         cross join lateral generate_series(greatest(p.start_date, d1),
                                            least(p.end_date, d2), interval '1 day') g
    where p.team_id = t and p.start_date <= d2 and p.end_date >= d1
      and (select ok from mem)
  ),
  votes as (
    select v.vote_date, v.choice, v.from_hour, v.to_hour, v.user_id
    from public.day_votes v
    where v.team_id = t
      and v.vote_date >= d1
      and v.vote_date <= d2
      and (select ok from mem)
  ),
  -- 표와 일정을 한 판으로 합친다. 일정이 있으면 그 사람은 그 날 불가로 친다.
  mine as (
    select vote_date, user_id,
           case when exists (select 1 from plan_days pd
                              where pd.vote_date = v.vote_date and pd.user_id = v.user_id)
                then 'x' else choice end as choice,
           from_hour, to_hour
    from votes v
    union all
    select pd.vote_date, pd.user_id, 'x', null::smallint, null::smallint
    from plan_days pd
    where not exists (select 1 from votes v
                       where v.vote_date = pd.vote_date and v.user_id = pd.user_id)
  ),
  -- 시작~종료를 시(hour) 단위로 펼쳐서 센다. 끝 시각은 제외 — 19~22 는 19,20,21 시에 있다는 뜻.
  hrs as (
    select m.vote_date, g.h, count(*)::int as cnt
    from mine m
         cross join lateral generate_series(m.from_hour::int, (m.to_hour - 1)::int) as g(h)
    where m.choice = 'o' and m.from_hour is not null and m.to_hour is not null
    group by m.vote_date, g.h
  ),
  -- 그 날 걸려 있는 일정 이름별 인원수 (이름만 나가고 누구인지는 나가지 않는다)
  rsn as (
    select pd.vote_date, pd.reason, count(distinct pd.user_id)::int as cnt
    from plan_days pd
    group by pd.vote_date, pd.reason
  )
  -- 한 사람이 같은 날 일정을 여러 개 걸어도 인원수는 1이어야 하므로 distinct user_id 로 센다.
  select c.vote_date,
         (count(distinct c.user_id) filter (where c.choice = 'o'))::integer,
         (count(distinct c.user_id) filter (where c.choice = 'x'))::integer,
         coalesce((select jsonb_agg(jsonb_build_array(h.h, h.cnt) order by h.h)
                     from hrs h where h.vote_date = c.vote_date), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_array(r.reason, r.cnt) order by r.cnt desc, r.reason)
                     from rsn r where r.vote_date = c.vote_date), '[]'::jsonb)
  from mine c
  group by c.vote_date
$$;
grant execute on function public.vote_counts(uuid, date, date) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 4-2) 달력에 그릴 일정 막대 — 이름·기간·인원수만 나간다.
--   같은 이름이라도 기간이 다르면 다른 막대다. 예전처럼 날짜별 사유를 클라이언트가
--   이어 붙이지 않으므로, 두 사람의 '시험기간'이 기간이 다른데 하나로 합쳐지던 문제도 없다.
-- ─────────────────────────────────────────────────────────────
create or replace function public.plan_spans(t uuid, d1 date, d2 date)
returns table(name text, start_date date, end_date date, cnt integer)
language sql
stable
security definer
set search_path = public
as $$
  select btrim(p.name), p.start_date, p.end_date, count(distinct p.user_id)::integer
  from public.day_plans p
  where p.team_id = t
    and p.start_date <= d2
    and p.end_date >= d1
    and public.is_member_of(t)     -- 팀원이 아니면 빈 결과
  group by btrim(p.name), p.start_date, p.end_date
$$;
grant execute on function public.plan_spans(uuid, date, date) to authenticated;

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
  if to_regclass('public.day_plans')  is null then missing := missing || ' day_plans';  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'plan_spans')
    then missing := missing || ' plan_spans'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'vote_counts')
    then missing := missing || ' vote_counts'; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_team_admin')
    then missing := missing || ' is_team_admin'; end if;

  if missing <> '' then
    raise exception '설치가 덜 됐습니다. 빠진 것:%', missing;
  end if;
  raise notice '캘린더 설치 완료 — club_events / day_votes / day_plans / vote_counts / plan_spans / is_team_admin 모두 확인';
end $$;

-- 설치 후 확인 쿼리 (선택)
-- select p.proname, pg_get_function_arguments(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('vote_counts','is_member_of','is_team_admin');
-- SQL Editor 는 service_role 이라 RLS 를 우회합니다. 익명성 검증은 앱에서 하세요.
-- ═══════════════════════════════════════════════════════════════
