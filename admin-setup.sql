-- ═══════════════════════════════════════════════════════════════
-- 당동 앱 관리자 기능 설정 SQL
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다 (멱등).
-- ═══════════════════════════════════════════════════════════════

-- 1) 관리자 플래그 컬럼
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- 2) 관리자 판별 함수 (RLS 정책 안에서 재귀 없이 사용)
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- 3) RLS 활성화 + 기본 정책 (기존 앱 동작 유지: 누구나 읽기, 로그인 사용자 쓰기)
alter table public.games enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "public read games" on public.games;
create policy "public read games" on public.games
  for select using (true);

drop policy if exists "auth insert games" on public.games;
create policy "auth insert games" on public.games
  for insert to authenticated with check (true);

drop policy if exists "public read profiles" on public.profiles;
create policy "public read profiles" on public.profiles
  for select using (true);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

-- 4) 관리자 전용 정책: 경기 수정·삭제, 선수 정보 수정
drop policy if exists "admin update games" on public.games;
create policy "admin update games" on public.games
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin delete games" on public.games;
create policy "admin delete games" on public.games
  for delete to authenticated using (public.is_admin());

drop policy if exists "admin update profiles" on public.profiles;
create policy "admin update profiles" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- 5) 관리자 지정 ★ 아래 이름을 본인 표시이름으로 바꾼 뒤 주석(--)을 풀고 실행
-- update public.profiles set is_admin = true where display_name = '홍길동';

-- 지정 확인:
-- select display_name, is_admin from public.profiles where is_admin;
