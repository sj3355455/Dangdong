-- ═══════════════════════════════════════════════════════════════
-- 당동 — 선수 개인 기록을 팀 구분 없이 (player_games)
-- Supabase SQL Editor에 붙여넣고 Run. 멱등(여러 번 실행 안전).
--
-- 기록실의 선수 화면(내 기록 · 이름 눌러 들어가는 화면)은 그 사람이 뛴 모든 팀의 경기를
-- 합쳐 보여 준다. 그런데 games 는 team-isolation.sql 로 '내가 속한 팀 경기만' 읽히게
-- 잠겨 있어서, 나는 당동만 속해 있고 상대는 당동·문가냐디 둘 다 속해 있으면
-- 상대의 문가냐디 경기를 읽을 수 없다. 그래서 그 한 사람의 경기만 꺼내 주는 함수를 둔다.
--
-- 누가 부를 수 있나: 그 선수와 팀을 하나라도 같이 쓰는 사람(본인 포함) 또는 사이트 관리자.
--   → 모르는 사람의 기록을 id 만 알고 긁어 갈 수는 없다(shares_team_with 와 같은 기준).
--
-- 무엇을 주나: 그 선수가 들어간 경기 전부(팀 소속 경기만, team_id 가 없는 옛 기록은 뺀다).
--   · 내가 속한 팀의 경기 → players 를 그대로 (경기 상세까지 볼 수 있다)
--   · 내가 안 속한 팀의 경기 → 그 선수 본인 몫은 그대로, 나머지 사람은 이름·순위만 남긴다.
--       순위가 있어야 보정 승률·등수를 낼 수 있고, 이름은 '상대' 칸에 쓴다.
--       다른 사람의 계정 id·점수·이닝 같은 기록은 내보내지 않는다.
--   · full = 내가 그 팀 소속인가 (앱은 false 인 경기는 상세 화면으로 넘기지 않는다)
--
-- players 배열 순서는 원래대로 둔다 — 앱이 순번(indexOf)으로 등수를 맞춘다.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.player_games(p uuid)
returns setof jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
           'id',        g.id,
           'played_at', g.played_at,
           'team_id',   g.team_id,
           'team_name', t.name,
           'full',      acc.full,
           'players',   case when acc.full then g.players::jsonb else (
                          select jsonb_agg(
                                   case when e->>'id' = p::text then e
                                        else jsonb_build_object('name', e->'name', 'rank', e->'rank',
                                                                'win', e->'win', 'isTeam', e->'isTeam')
                                   end
                                   order by ord)
                            from jsonb_array_elements(g.players::jsonb) with ordinality as x(e, ord)
                        ) end
         )
    from public.games g
    join public.teams t on t.id = g.team_id
    cross join lateral (select public.is_member_of(g.team_id) or public.is_admin() as full) acc
   where (public.shares_team_with(p) or public.is_admin())
     and g.players::jsonb @> jsonb_build_array(jsonb_build_object('id', p::text))
   order by g.played_at asc
$$;

revoke execute on function public.player_games(uuid) from public, anon;
grant execute on function public.player_games(uuid) to authenticated;

-- PostgREST 가 새 함수를 곧바로 알아보게
notify pgrst, 'reload schema';

-- 확인(선택): SQL Editor 는 auth.uid() 가 없어 빈 결과가 정상이다. 앱에 로그인해서
-- 두 팀에 속한 선수의 기록 화면에 팀 버튼이 생기는지로 확인한다.
