-- ═══════════════════════════════════════════════════════════════
-- 3구 수지 (profiles.handicap3)
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다 (멱등).
--
-- 4구 수지(handicap)는 '표시 수지 ÷ 10' 을 저장하지만(15 = 수지 150),
-- 3구 수지는 목표 점수를 그대로 저장한다(20 = 20점). 둘은 따로 고친다 —
-- rename_player() 는 4구 수지만 건드리고, 3구 수지는 앱이 이 칸을 직접 PATCH 한다.
--
-- 경기 쪽은 바꿀 게 없다. 3구 경기는 games.players 의 선수마다 "ball": 3 이 붙고,
-- 그게 없는 경기(지금까지의 기록 전부)는 4구로 읽는다. 팀전 표시(isTeam)와 같은 방식.
--
-- 이 SQL 을 돌리기 전에도 앱은 깨지지 않는다 — 3구 수지만 비어 보이고 저장이 안 될 뿐.
-- ═══════════════════════════════════════════════════════════════

-- 1) 칸 — 비어 있으면(null) 3구 수지를 아직 안 정한 것
alter table public.profiles add column if not exists handicap3 integer;

alter table public.profiles drop constraint if exists profiles_handicap3_range;
alter table public.profiles add constraint profiles_handicap3_range
  check (handicap3 is null or handicap3 between 1 and 99);

-- 2) 쓰기 권한 — 프로필 수정은 칸 단위로 열어 두었다(admin-setup.sql). 새 칸도 열어 준다.
--    누가 어느 행을 고칠 수 있는지는 기존 정책 그대로다: 본인("update own profile") · 관리자("admin update profiles")
grant update (handicap3) on public.profiles to authenticated;

-- 확인(선택):
-- select display_name, handicap, handicap3 from public.profiles order by display_name;
