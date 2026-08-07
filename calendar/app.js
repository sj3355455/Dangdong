// 당동 캘린더 — 정기전 일정 · 경기 판수 · 참여 익명 투표
//
// 익명성은 서버(RLS)가 지킨다. 이 파일은 남의 표를 조회하는 코드를 아예 갖고 있지 않다.
//   · 내 표      : day_votes 에서 내 행만 읽고 쓴다 (RLS 가 남의 행을 막는다)
//   · 인원수     : vote_counts() 함수가 서버에서 세어 O/X 숫자만 돌려준다
// 자세한 정책은 저장소 루트의 calendar-setup.sql 참고.
import { sbFetch } from '../record/supabase.js';
import { registerSW, getTheme, applyTheme, LS_THEME, initTeamModal } from '../record/common.js';

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

const LS_AUTH = 'dangScoreAuth', LS_TEAM = 'dangCurrentTeam';
const getAuth = () => { try { const v = localStorage.getItem(LS_AUTH); return v ? JSON.parse(v) : null; } catch(e){ return null; } };
const tGet = () => { try { return JSON.parse(localStorage.getItem(LS_TEAM)); } catch(e){ return null; } };
const tSet = v => { try { localStorage.setItem(LS_TEAM, JSON.stringify(v)); } catch(e){} };

let myTeams = [];
let currentTeam = tGet();
let isTeamLeader = false;

// 보고 있는 달 (1일 기준)
let cur = new Date(); cur.setDate(1); cur.setHours(0, 0, 0, 0);

// 이번 달 데이터 — 모두 'YYYY-MM-DD' 를 키로 쓴다
let events = {};    // 날짜 → { id, round_no, note }
let gameCnt = {};   // 날짜 → 경기 판수
let counts = {};    // 날짜 → { o, x }
let myVote = {};    // 날짜 → { c:'o'|'x', from, to, reason } — day_votes 의 내 행 그대로
let loading = false;
let loadErr = '';   // 이번 달 데이터를 못 불러온 이유 (화면에 그대로 띄운다)

// ── 날짜 유틸 (로컬 시간 기준. toISOString 은 UTC 라 하루 밀릴 수 있어 쓰지 않는다) ──
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const todayStr = () => ymd(new Date());
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
// 지난 날짜엔 투표할 수 없다 (이미 지나간 날의 참여 여부를 받을 이유가 없다).
// 키가 'YYYY-MM-DD' 라 문자열 비교로 충분하다.
const isPast = key => key < todayStr();
// 그 날 내가 고른 값 ('o' | 'x' | null). myVote 는 시간·사유까지 담은 객체라 한 겹 벗겨서 쓴다.
const myChoice = key => (myVote[key] && myVote[key].c) || null;
const label = key => {
  const [y, m, dd] = key.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  return `${m}월 ${dd}일 (${DOW[d.getDay()]})`;
};

// ══ 데이터 ══
async function loadTeams(){
  const auth = getAuth();
  if (!auth || !auth.uid) { myTeams = []; return; }
  try {
    const rows = await sbFetch('/rest/v1/rpc/my_teams', { method: 'POST', body: JSON.stringify({}) });
    myTeams = Array.isArray(rows) ? rows : [];
    const remembered = tGet();
    if (remembered && myTeams.some(t => t.id === remembered)) currentTeam = remembered;
    else currentTeam = myTeams[0] ? myTeams[0].id : null;
    tSet(currentTeam);
  } catch(e){ /* my_teams 미배포 → 팀 없음으로 처리 */ }
  const me = myTeams.find(t => t.id === currentTeam);
  isTeamLeader = !!(me && me.is_admin);
}

// 이번 달의 첫날/마지막날 (문자열)
function monthRange(){
  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const last  = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
  return [ymd(first), ymd(last)];
}

let monthCache = {};

function getMonthKey() {
  return (currentTeam || 'none') + ':' + cur.getFullYear() + '-' + pad(cur.getMonth() + 1);
}

function updateMonthCache() {
  const k = getMonthKey();
  monthCache[k] = {
    events: { ...events },
    gameCnt: { ...gameCnt },
    counts: { ...counts },
    myVote: { ...myVote },
    loadErr
  };
}

function clearMonth(){
  events = {}; gameCnt = {}; counts = {}; myVote = {}; loadErr = '';
}
function applyCache(c){
  events = { ...c.events };
  gameCnt = { ...c.gameCnt };
  counts = { ...c.counts };
  myVote = { ...c.myVote };
  loadErr = c.loadErr;
}

async function loadMonth(force = false){
  if (!currentTeam) { clearMonth(); return; }
  const cacheKey = getMonthKey();
  if (!force && monthCache[cacheKey]) { applyCache(monthCache[cacheKey]); return; }

  clearMonth();
  const [d1, d2] = monthRange();
  const auth = getAuth();

  // 다음 달 1일 00:00 (경기 조회 상한 — played_at 은 timestamptz 라 날짜 비교가 아니라 범위로 자른다)
  const nextMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);

  const [ev, games, cnt, mine] = await Promise.allSettled([
    sbFetch(`/rest/v1/club_events?select=id,event_date,round_no,note&team_id=eq.${currentTeam}`
          + `&event_date=gte.${d1}&event_date=lte.${d2}`),
    sbFetch(`/rest/v1/games?select=played_at&team_id=eq.${currentTeam}`
          + `&played_at=gte.${d1}T00:00:00&played_at=lt.${ymd(nextMonth)}T00:00:00`),
    sbFetch('/rest/v1/rpc/vote_counts', { method: 'POST', body: JSON.stringify({ t: currentTeam, d1, d2 }) }),
    auth && auth.uid
      ? sbFetch(`/rest/v1/day_votes?select=vote_date,choice,from_hour,to_hour,reason&team_id=eq.${currentTeam}`
              + `&vote_date=gte.${d1}&vote_date=lte.${d2}`)
      : Promise.resolve([])
  ]);

  if (ev.status === 'fulfilled' && Array.isArray(ev.value))
    for (const e of ev.value) events[e.event_date] = e;

  if (games.status === 'fulfilled' && Array.isArray(games.value))
    for (const g of games.value) {
      const k = ymd(new Date(g.played_at));
      gameCnt[k] = (gameCnt[k] || 0) + 1;
    }

  // 남의 표는 RLS 로 막혀 있어 이 집계 함수 말고는 인원수를 알 방법이 없다.
  // 그래서 여기서 실패하면 '나만 보이고 남은 안 보이는' 상태가 된다 → 조용히 넘기지 않고 드러낸다.
  // hours/reasons 는 vote_counts 를 새로 배포하기 전이면 안 온다 → 빈 배열로 두고 나머지는 그대로 굴린다
  if (cnt.status === 'fulfilled' && Array.isArray(cnt.value))
    for (const c of cnt.value) counts[c.vote_date] = {
      o: c.o_cnt || 0, x: c.x_cnt || 0,
      hours: Array.isArray(c.hours) ? c.hours : [],       // [[시, 인원], ...]
      reasons: Array.isArray(c.reasons) ? c.reasons : []  // [[사유, 인원], ...]
    };
  else
    loadErr = describeCountErr(cnt.reason);

  // day_votes 는 RLS 상 '내 행'만 돌아온다 — 그래서 이게 곧 내 표다
  if (mine.status === 'fulfilled' && Array.isArray(mine.value))
    for (const v of mine.value)
      myVote[v.vote_date] = { c: v.choice, from: v.from_hour, to: v.to_hour, reason: v.reason };
  else if (!loadErr)
    loadErr = '내 투표를 불러오지 못했습니다: ' + errText(mine.reason);

  updateMonthCache();
}

const errText = e => (e && (e.message || e.msg)) || '알 수 없는 오류';

// 집계 실패는 원인이 갈린다. 사람이 바로 조치할 수 있게 구분해서 알려준다.
function describeCountErr(e){
  const st = e && e.status;
  if (st === 404 || st === 400) {
    return '투표 집계 함수(vote_counts)를 찾지 못했습니다. calendar-setup.sql 을 Supabase 에서 실행했는지, '
         + '실행했다면 스키마 캐시가 갱신됐는지 확인해 주세요. (' + errText(e) + ')';
  }
  if (st === 401 || st === 403) {
    return '투표 집계를 볼 권한이 없습니다. 이 팀의 팀원인지 확인해 주세요. (' + errText(e) + ')';
  }
  return '투표 인원수를 불러오지 못했습니다: ' + errText(e);
}

// ══ 화면 ══
function render(){
  const view = $('#view');
  const auth = getAuth();

  if (!auth) {
    view.innerHTML = `<div class="card"><div class="empty">
      캘린더를 쓰려면 로그인이 필요합니다.
      <div style="margin-top:18px"><a href="../score/" class="bigbtn" style="display:inline-block;text-decoration:none;max-width:260px;">점수판으로 가서 로그인</a></div>
    </div></div>`;
    return;
  }
  if (!currentTeam) {
    view.innerHTML = `<div class="card"><div class="empty">
      소속된 팀이 없습니다.<br>⚙️ 설정 → 팀 설정에서 팀에 참가하거나 만들어 주세요.
    </div></div>`;
    return;
  }

  const y = cur.getFullYear(), m = cur.getMonth();
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const lead = first.getDay();               // 1일 앞의 빈 칸 수
  const today = todayStr();

  // 달력을 '주' 단위로 쌓는다. 여러 날짜에 걸친 일정 막대를 한 줄로 이으려면
  // 그 주 안에서 몇 번째 칸부터 몇 칸인지를 알아야 하기 때문이다.
  const slots = [];                                    // 42칸 안팎의 격자 — 앞뒤 빈 칸은 null
  for (let i = 0; i < lead; i++) slots.push(null);
  for (let d = 1; d <= daysInMonth; d++) slots.push(`${y}-${pad(m + 1)}-${pad(d)}`);
  while (slots.length % 7) slots.push(null);

  const lanesOf = spansForMonth();                     // 이 달의 일정 막대 (사유별로 이어 붙인 것)

  let weeks = '';
  for (let w = 0; w * 7 < slots.length; w++) {
    const row = slots.slice(w * 7, w * 7 + 7);
    const bars = barsForWeek(row, lanesOf);
    const laneCount = bars.reduce((n, b) => Math.max(n, b.lane + 1), 0);
    // 막대가 놓일 만큼 칸 아래를 비워 둔다 — 그래야 O/X 알약과 겹치지 않는다
    const padBottom = 4 + laneCount * (BAR_H + 2);

    let cells = '';
    for (const key of row) {
      if (!key) { cells += '<div class="cell pad"></div>'; continue; }
      const d = Number(key.slice(8));
      const dow = new Date(y, m, d).getDay();
      const ev = events[key], g = gameCnt[key], c = counts[key] || { o: 0, x: 0 }, mv = myChoice(key);
      const cls = ['cell'];
      if (key === today) cls.push('today');
      if (mv) cls.push('mine');
      if (key < today) cls.push('past');   // 투표 불가 — 눌러서 정기전·판수는 볼 수 있다
      const dcls = dow === 0 ? ' sun' : dow === 6 ? ' sat' : '';
      cells += `<div class="${cls.join(' ')}" data-d="${key}" style="padding-bottom:${padBottom}px">
        ${mv ? `<span class="mymark ${mv}">${mv === 'o' ? 'O' : 'X'}</span>` : ''}
        <span class="dnum${dcls}">${d}</span>
        ${ev ? `<span class="evchip">${ev.round_no ? esc(ev.round_no) + '회' : '정기전'}</span>` : ''}
        ${g ? `<span class="gchip">🎱 ${g}판</span>` : ''}
        <span class="votes">
          ${c.o ? `<span class="vpill o">O ${c.o}</span>` : ''}
          ${c.x ? `<span class="vpill x">X ${c.x}</span>` : ''}
        </span>
      </div>`;
    }
    weeks += `<div class="week"><div class="wrow">${cells}</div>`
           + `<div class="wbars" style="height:${laneCount * (BAR_H + 2)}px">`
           + bars.map(b => `<span class="xbar${b.lcap ? ' lcap' : ''}${b.rcap ? ' rcap' : ''}"
                 style="left:${colLeft(b.col)}; width:${colWidth(b.len)}; top:${b.lane * (BAR_H + 2)}px"
                 title="${esc(b.reason)}">${b.lcap ? esc(b.reason) : ''}</span>`).join('')
           + `</div></div>`;
  }

  view.innerHTML = `
    ${loadErr ? `<div class="card" style="border-color:var(--no)">
      <div style="font-weight:700; color:var(--no); margin-bottom:6px;">⚠️ 투표 현황을 불러오지 못했습니다</div>
      <div class="sub" style="color:var(--text)">${esc(loadErr)}</div>
      <div class="sub" style="margin-top:8px">이 상태에서는 다른 부원의 표가 보이지 않습니다.</div>
    </div>` : ''}
    <div class="monthbar">
      <button class="mbtn" id="prevM" aria-label="이전 달">‹</button>
      <b>${y}년 ${m + 1}월</b>
      <button class="mbtn" id="nextM" aria-label="다음 달">›</button>
    </div>
    <div class="dow">${DOW.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
    <div class="gridclip"><div class="grid" id="grid">${weeks}</div></div>
    <div class="sub" style="text-align:center; margin:14px 0 20px;">
      날짜를 눌러 참여 가능 여부를 남기세요. 누가 골랐는지는 공개되지 않습니다.
    </div>
    ${topDaysHtml()}
  `;

  $('#prevM').onclick = () => moveMonth(-1);
  $('#nextM').onclick = () => moveMonth(1);
  document.querySelectorAll('#grid .cell[data-d]').forEach(el => {
    el.onclick = () => { if (!swallowClick()) openDay(el.dataset.d); };
  });
  bindSwipe($('#grid'));
}

// ══ 좌우 드래그로 달 넘기기 ══
// 격자는 CSS 의 touch-action:pan-y 로 가로 제스처만 넘겨받는다 — 세로 스크롤은 브라우저가 그대로 처리.
// 포인터 이벤트라 손가락과 마우스가 같은 코드를 탄다.
const SWIPE_GO = 60;    // 이만큼 끌면 달이 넘어간다
const SWIPE_SLOP = 12;  // 이 전에는 가로/세로 방향을 판단하지 않는다
let swipedAt = 0;       // 스와이프 직후 따라오는 click 을 한 번 무시하기 위한 표시

// 드래그로 달을 넘긴 직후의 click 이면 삼킨다 (날짜 상세가 열리지 않도록)
const swallowClick = () => Date.now() - swipedAt < 400;

function bindSwipe(grid){
  if (!grid) return;
  let x0 = 0, y0 = 0, dx = 0, dragging = false, decided = false, horiz = false;

  const reset = () => { grid.style.transition = 'transform .18s, opacity .18s'; grid.style.transform = ''; grid.style.opacity = ''; };

  grid.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    x0 = e.clientX; y0 = e.clientY;
    dx = 0; dragging = true; decided = false; horiz = false;
    grid.style.transition = '';
  });

  grid.addEventListener('pointermove', e => {
    if (!dragging || !e.isPrimary) return;
    dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!decided) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
      decided = true;
      horiz = Math.abs(dx) > Math.abs(dy);
      if (!horiz) { dragging = false; reset(); return; }   // 세로 제스처면 손을 뗀다
    }
    // 손가락보다 덜 따라가게 해서 고무줄처럼 끌리는 느낌을 준다
    grid.style.transform = `translateX(${dx * 0.55}px)`;
    grid.style.opacity = String(Math.max(.45, 1 - Math.abs(dx) / 420));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (horiz && Math.abs(dx) >= SWIPE_GO) {
      // 제자리로 되돌리지 않는다 — 지금 위치에서 그대로 이어서 밀려 나가야 뚝 끊기지 않는다
      swipedAt = Date.now();
      moveMonth(dx < 0 ? 1 : -1);
    } else {
      reset();                       // 기준에 못 미치면 제자리로
    }
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
  grid.addEventListener('pointerleave', end);
}

// 이번 달에서 모이기 좋은 날 — 가능 인원이 많고 불가 인원이 적은 순.
// 약속을 잡으려고 보는 목록이므로 이미 지난 날짜는 뺀다.
function topDaysHtml(){
  const rows = Object.keys(counts)
    .map(k => ({ k, o: counts[k].o || 0, x: counts[k].x || 0 }))
    .filter(r => r.o > 0 && !isPast(r.k))
    .sort((a, b) => (b.o - b.x) - (a.o - a.x) || b.o - a.o || a.k.localeCompare(b.k))
    .slice(0, 5);
  if (!rows.length) return '';
  const max = Math.max(...rows.map(r => r.o + r.x));
  return `<div class="card">
    <div style="font-weight:700; margin-bottom:6px;">🗓 모이기 좋은 날</div>
    <div class="sub" style="margin-bottom:6px;">가능 인원이 많고 불가 인원이 적은 순</div>
    ${rows.map(r => `<div class="topday">
      <span class="d">${label(r.k)}</span>
      <span class="bar">
        <i class="o" style="width:${(r.o / max) * 100}%"></i>
        <i class="x" style="width:${(r.x / max) * 100}%"></i>
      </span>
      <span class="n">O ${r.o} · X ${r.x}</span>
    </div>`).join('')}
  </div>`;
}

// ══ 여러 날에 걸친 일정 막대 ══
// 서버는 날짜별로 [사유, 인원] 만 준다. 같은 사유가 연달아 붙어 있는 구간을 여기서 이어 붙여
// 하나의 일정으로 본다. 이름만 쓰므로 누가 등록했는지는 여전히 드러나지 않는다.
const BAR_H = 13;                                   // 막대 한 줄 높이(px)
// 칸 간격은 CSS 의 --gap 하나만 보고 계산한다 — 여기에 숫자를 박아 두면 CSS 를 고칠 때 막대가 어긋난다.
const colLeft  = i => `calc((100% - var(--gap) * 6) / 7 * ${i} + var(--gap) * ${i})`;
const colWidth = n => `calc((100% - var(--gap) * 6) / 7 * ${n} + var(--gap) * ${n - 1})`;

// 이 달에 보이는 모든 일정 구간 → [{ reason, from, to }]  (from/to 는 'YYYY-MM-DD')
function spansForMonth(){
  const byReason = {};                              // 사유 → 날짜 집합
  for (const k in counts) {
    for (const [reason] of (counts[k].reasons || [])) {
      (byReason[reason] || (byReason[reason] = [])).push(k);
    }
  }
  const spans = [];
  for (const reason in byReason) {
    const days = byReason[reason].sort();
    let from = days[0], prev = days[0];
    for (let i = 1; i <= days.length; i++) {
      const d = days[i];
      // 하루라도 끊기면 거기서 구간을 자른다
      if (d && addDays(prev, 1) === d) { prev = d; continue; }
      spans.push({ reason, from, to: prev });
      from = prev = d;
    }
  }
  // 2일 이상만 막대로 그린다. 하루짜리는 칸 안의 X 알약으로 이미 보인다.
  return spans.filter(s => s.from !== s.to);
}

const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
};

// 한 주(7칸)에 걸치는 막대 조각들 → 겹치지 않게 위아래 줄(lane)을 배정한다
function barsForWeek(row, spans){
  const segs = [];
  for (const s of spans) {
    let col = -1, len = 0;
    for (let i = 0; i < 7; i++) {
      const k = row[i];
      if (k && k >= s.from && k <= s.to) { if (col < 0) col = i; len++; }
    }
    if (col < 0) continue;
    segs.push({
      reason: s.reason, col, len,
      lcap: row[col] === s.from,              // 일정이 여기서 시작하면 왼쪽을 둥글게
      rcap: row[col + len - 1] === s.to       // 여기서 끝나면 오른쪽을 둥글게
    });
  }
  // 시작이 빠른 것부터, 빈 줄 중 가장 위에 넣는다
  segs.sort((a, b) => a.col - b.col || b.len - a.len);
  const lanes = [];
  for (const s of segs) {
    let L = 0;
    while (lanes[L] && lanes[L] > s.col) L++;      // 그 줄의 마지막 끝보다 뒤면 같은 줄에 놓을 수 있다
    s.lane = L;
    lanes[L] = s.col + s.len;
  }
  return segs;
}

// 달 넘기기 — 밀려 나가고 반대쪽에서 밀려 들어온다.
// 네트워크를 기다리면 화면이 멈추므로, 캐시가 있으면 바로 그리고 없으면 빈 달을 먼저 그린 뒤
// 데이터가 오면 다시 그린다. 애니메이션이 통신 속도에 끌려가지 않게 하는 게 핵심.
const OUT_MS = 140, IN_MS = 180;
const wait = ms => new Promise(r => setTimeout(r, ms));
let sliding = false;

async function moveMonth(delta){
  if (sliding) return;
  sliding = true;
  try {
    const g = $('#grid');
    if (g) {
      // 드래그 중이었다면 지금 손가락이 있던 위치에서 이어서 밀려 나간다 (transform 을 지우지 않는다)
      g.style.transition = `transform ${OUT_MS}ms ease-in, opacity ${OUT_MS}ms ease-in`;
      g.style.transform = `translateX(${delta > 0 ? -38 : 38}%)`;
      g.style.opacity = '0';
      await wait(OUT_MS);
    }

    cur = new Date(cur.getFullYear(), cur.getMonth() + delta, 1);
    const cached = monthCache[getMonthKey()];
    if (cached) applyCache(cached); else clearMonth();
    render();

    const n = $('#grid');
    if (n) {
      n.style.transition = 'none';
      n.style.transform = `translateX(${delta > 0 ? 38 : -38}%)`;
      n.style.opacity = '0';
      // 두 프레임 뒤에 풀어야 브라우저가 시작 상태를 확정한 뒤 전환을 시작한다
      requestAnimationFrame(() => requestAnimationFrame(() => {
        n.style.transition = `transform ${IN_MS}ms ease-out, opacity ${IN_MS}ms ease-out`;
        n.style.transform = '';
        n.style.opacity = '';
      }));
    }
  } finally { sliding = false; }

  if (!monthCache[getMonthKey()]) await refresh();   // 아직 안 받아온 달이면 이어서 불러온다
}

async function refresh(force = false){
  if (loading) return;
  loading = true;
  try { await loadMonth(force); } finally { loading = false; }
  render();
}

// ══ 날짜 상세 ══
let openKey = null;

function openDay(key){
  openKey = key;
  const ev = events[key], g = gameCnt[key] || 0, c = counts[key] || { o: 0, x: 0 };
  $('#dsTitle').textContent = label(key);

  const bits = [];
  if (ev) bits.push(ev.round_no ? `🏅 ${ev.round_no}회 정기전` : '🏅 정기전');
  if (ev && ev.note) bits.push(esc(ev.note));
  if (g) bits.push(`🎱 ${g}판`);
  $('#dsInfo').innerHTML = bits.join(' · ') || '기록된 일정이 없습니다.';

  // 점수판이 투표 버튼이므로 지난 날짜엔 숫자만 남기고 버튼을 잠근다.
  const past = isPast(key);
  $('#dsO').disabled = past;
  $('#dsX').disabled = past;
  $('#dsPastNote').style.display = past ? '' : 'none';
  syncVoteUI();
  $('#dsCntO').textContent = c.o;
  $('#dsCntX').textContent = c.x;
  renderAgg(key);

  const adm = $('#dsAdm');
  adm.style.display = isTeamLeader ? 'block' : 'none';
  if (isTeamLeader) {
    $('#dsRound').value = ev && ev.round_no != null ? ev.round_no : '';
    $('#dsNote').value = ev && ev.note ? ev.note : '';
    $('#dsDel').style.display = ev ? '' : 'none';
  }
  msg('');
  $('#daySheet').classList.add('on');
}

function syncVoteUI(){
  const mv = myChoice(openKey);
  const o = $('#dsO'), x = $('#dsX');
  o.classList.toggle('on', mv === 'o');
  x.classList.toggle('on', mv === 'x');
  o.setAttribute('aria-pressed', mv === 'o');
  x.setAttribute('aria-pressed', mv === 'x');

  // O 를 골랐으면 시간 칸, X 를 골랐으면 사유 칸. 지난 날짜엔 둘 다 닫는다.
  const past = isPast(openKey);
  const meta = myVote[openKey] || {};
  $('#dsWhen').style.display = (mv === 'o' && !past) ? '' : 'none';
  $('#dsWhy').style.display  = (mv === 'x' && !past) ? '' : 'none';
  if (mv === 'o') {
    // 시간을 안 적은 사람은 '무관'. 기본값을 함부로 넣으면 아무 때나 되는 사람이
    // 특정 시간대만 되는 것처럼 집계돼서, 비워 두는 쪽을 기본으로 한다.
    // 시트가 화면에 올라온 뒤에 스크롤을 잡아야 해서 다음 프레임으로 미룬다.
    requestAnimationFrame(() => {
      setWheel($('#dsFrom'), FROM_OPTS, meta.from != null ? meta.from : null);
      setWheel($('#dsTo'), TO_OPTS, meta.to != null ? meta.to : 1);
      syncToWheelState();
    });
  }
  if (mv === 'x') {
    $('#dsReason').value = meta.reason || '';
    // 기본 기간은 연 날짜 하루. 지난 날짜는 못 고르게 min 을 오늘로 묶는다.
    const s = $('#dsStart'), e = $('#dsEnd');
    s.min = e.min = todayStr();
    s.value = openKey;
    e.value = openKey;
  }
}

// ══ 시간 휠 (점수판 제한시간 피커와 같은 방식) ══
// 스크롤 스냅으로 돌리고, 멈춘 뒤에 저장한다. 한 칸 넘어갈 때마다 저장하면 통신이 폭주한다.
const hourLabel = h => h === 24 ? '자정' : `${h}시`;
const HW_ITEM_H = 36;                                   // .hw .hi 높이(px)와 일치해야 한다
const FROM_OPTS = [null];                               // null = 시간 무관
for (let h = 0; h <= 23; h++) FROM_OPTS.push(h);
const TO_OPTS = [];
for (let h = 1; h <= 24; h++) TO_OPTS.push(h);

function buildWheel(el, opts, onSettle){
  el.innerHTML = '<div class="hi-pad"></div>'
    + opts.map(v => `<div class="hi">${v == null ? '무관' : hourLabel(v)}</div>`).join('')
    + '<div class="hi-pad"></div>';
  el._opts = opts;
  el._val = opts[0];
  let raf, settle;
  // 사람이 직접 만지기 전에는 저장하지 않는다 — 값을 맞추려고 스크롤을 옮길 때도 scroll 이 뜨기 때문
  el.addEventListener('pointerdown', () => { el._user = true; });
  el.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const i = Math.max(0, Math.min(opts.length - 1, Math.round(el.scrollTop / HW_ITEM_H)));
      el.querySelectorAll('.hi').forEach((d, k) => d.classList.toggle('sel', k === i));
      if (el._val !== opts[i]) { el._val = opts[i]; vibTick(); }
      if (!el._user) return;
      clearTimeout(settle);
      settle = setTimeout(onSettle, 400);               // 손을 뗀 뒤 멈추면 그때 저장
    });
  });
}

function setWheel(el, opts, v){
  const i = Math.max(0, opts.indexOf(v));
  el._user = false;                                     // 프로그램이 옮긴 것이므로 저장 트리거 금지
  el._val = opts[i];
  el.scrollTop = i * HW_ITEM_H;
  el.querySelectorAll('.hi').forEach((d, k) => d.classList.toggle('sel', k === i));
}

const vibTick = () => { try { navigator.vibrate && navigator.vibrate(6); } catch(e){} };

// 시작이 '무관'이면 종료 휠은 쓸 일이 없다 → 흐리게 잠근다
function syncToWheelState(){
  $('#dsTo').classList.toggle('off', $('#dsFrom')._val == null);
}

const RANGE_MAX = 90;   // 한 번에 등록할 수 있는 최대 일수 (실수로 몇 년치를 채우는 걸 막는다)

function msg(t, kind){
  const el = $('#dsMsg');
  el.textContent = t;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// 투표 저장 — 같은 값을 다시 누르면 취소로 동작
async function vote(choice){
  const auth = getAuth();
  if (!auth || !currentTeam) return;
  const key = openKey;
  if (isPast(key)) return;   // 지난 날짜는 투표 대상이 아니다 (UI도 가려져 있지만 이중으로 막는다)
  const prevRow = myVote[key];
  const prev = myChoice(key);
  const next = (choice && choice !== prev) ? choice : null;

  // 시간·사유는 비운 채로 시작한다 — 누른 즉시 아래 칸이 열리니 원하면 거기서 채운다
  const nextRow = next ? { c: next, from: null, to: null, reason: null } : null;

  // 낙관적 반영: 숫자를 먼저 움직여 두고, 실패하면 되돌린다
  const c = counts[key] || (counts[key] = { o: 0, x: 0, hours: [], reasons: [] });
  if (prev) c[prev] = Math.max(0, c[prev] - 1);
  if (next) c[next] = (c[next] || 0) + 1;
  if (nextRow) myVote[key] = nextRow; else delete myVote[key];
  syncVoteUI();
  $('#dsCntO').textContent = c.o;
  $('#dsCntX').textContent = c.x;
  msg('저장 중...');

  try {
    if (nextRow) {
      await upsertVotes([rowFor(key, nextRow)]);
    } else {
      await sbFetch(`/rest/v1/day_votes?team_id=eq.${currentTeam}&vote_date=eq.${key}&user_id=eq.${auth.uid}`,
        { method: 'DELETE' });
    }
    msg(next ? (next === 'o' ? '가능으로 저장했습니다.' : '불가로 저장했습니다.') : '표를 취소했습니다.', 'ok');
    updateMonthCache();
    render();
    await reloadAgg();
  } catch(e){
    // 되돌리기
    if (next) c[next] = Math.max(0, c[next] - 1);
    if (prev) c[prev] = (c[prev] || 0) + 1;
    if (prevRow) myVote[key] = prevRow; else delete myVote[key];
    syncVoteUI();
    $('#dsCntO').textContent = c.o;
    $('#dsCntX').textContent = c.x;
    updateMonthCache();
    msg('저장하지 못했습니다: ' + (e.message || '알 수 없는 오류'), 'err');
  }
}

// day_votes 한 행으로 만든다. 안 쓰는 열은 명시적으로 null 을 넣어야 예전 값이 남지 않는다.
function rowFor(key, row){
  const auth = getAuth();
  return {
    team_id: currentTeam, vote_date: key, user_id: auth.uid, choice: row.c,
    from_hour: row.c === 'o' ? row.from : null,
    to_hour:   row.c === 'o' ? row.to   : null,
    reason:    row.c === 'x' ? (row.reason || null) : null,
    updated_at: new Date().toISOString()
  };
}

const upsertVotes = rows => sbFetch('/rest/v1/day_votes?on_conflict=team_id,vote_date,user_id', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify(rows)
});

// 가능 시간 변경 — 이미 O 를 고른 상태에서만 불린다
async function saveHours(){
  const key = openKey, row = myVote[key];
  if (!row || row.c !== 'o' || isPast(key)) return;
  const fw = $('#dsFrom'), tw = $('#dsTo');
  let from = fw._val, to = tw._val;
  // 시작이 '무관'이면 시간 조건 자체가 없다 → 둘 다 비운다 (DB CHECK 가 '둘 다 null' 만 허용)
  if (from == null) { to = null; }
  // 끝이 시작보다 빠르면 조용히 밀어 준다 (저장이 CHECK 에 걸려 실패하는 것보다 낫다)
  else if (!(from < to)) { to = Math.min(24, from + 1); setWheel(tw, TO_OPTS, to); }
  syncToWheelState();

  // 캐시가 myVote 를 얕게 복사해 두므로 기존 객체를 고치면 캐시까지 같이 바뀐다 → 새 객체로 교체한다
  const before = row;
  myVote[key] = { ...row, from, to };
  msg('저장 중...');
  try {
    await upsertVotes([rowFor(key, myVote[key])]);
    msg(from == null ? '시간 무관으로 저장했습니다.' : `${hourLabel(from)}~${hourLabel(to)} 가능으로 저장했습니다.`, 'ok');
    updateMonthCache();
    await reloadAgg();
  } catch(e){
    myVote[key] = before;
    updateMonthCache();
    syncVoteUI();
    msg('저장하지 못했습니다: ' + (e.message || '알 수 없는 오류'), 'err');
  }
}

// 불가 사유 + 기간 — 연 날짜부터 고른 날짜까지 전부 X 로 채운다
async function saveRange(){
  const key = openKey, row = myVote[key];
  const auth = getAuth();
  if (!auth || !row || row.c !== 'x' || isPast(key)) return;
  const reason = $('#dsReason').value.trim() || null;
  const start = $('#dsStart').value, end = $('#dsEnd').value;
  if (!start || !end) return msg('시작일과 종료일을 골라 주세요.', 'err');
  if (end < start) return msg('종료일이 시작일보다 빠릅니다.', 'err');

  // 시작일부터 종료일까지 하루씩. 오늘 이전은 투표 대상이 아니므로 건너뛴다.
  const [y, m, d0] = start.split('-').map(Number);
  const dates = [];
  for (const d = new Date(y, m - 1, d0); ymd(d) <= end; d.setDate(d.getDate() + 1)) {
    if (!isPast(ymd(d))) dates.push(ymd(d));
    if (dates.length > RANGE_MAX) return msg(`한 번에 ${RANGE_MAX}일까지만 등록할 수 있습니다.`, 'err');
  }
  if (!dates.length) return msg('저장할 날짜가 없습니다.', 'err');

  msg(`${dates.length}일 저장 중...`);
  try {
    await upsertVotes(dates.map(k => rowFor(k, { c:'x', reason })));
    // 성공한 뒤에 서버 값을 다시 읽어 화면을 맞춘다 (여러 날이 한꺼번에 바뀌므로 낙관적 반영은 하지 않는다)
    await refresh(true);
    openDay(key);
    msg(dates.length === 1 ? '불가로 저장했습니다.' : `${label(dates[0])}부터 ${dates.length}일을 불가로 저장했습니다.`, 'ok');
  } catch(e){
    msg('저장하지 못했습니다: ' + (e.message || '알 수 없는 오류'), 'err');
  }
}

// 표를 바꾼 뒤 집계(시간대·사유)를 다시 읽어 시트에 반영한다
async function reloadAgg(){
  await refresh(true);
  if ($('#daySheet').classList.contains('on')) renderAgg(openKey);
}

// 익명 집계 — 시간대별 가능 인원 막대 + 불가 사유별 인원. 이름은 서버에서부터 나오지 않는다.
function renderAgg(key){
  const c = counts[key] || {};
  const hours = c.hours || [], reasons = c.reasons || [];
  let html = '';

  if (hours.length) {
    // 가로축은 시간. 사람이 있는 구간만 그리되 중간에 빈 시간이 있으면 0 으로 채워 축이 끊기지 않게 한다.
    const lo = Math.min(...hours.map(h => h[0]));
    const hi = Math.max(...hours.map(h => h[0]));
    const at = Object.fromEntries(hours);
    const max = Math.max(...hours.map(h => h[1]));
    let cols = '';
    for (let h = lo; h <= hi; h++) {
      const n = at[h] || 0;
      cols += `<div class="hcol${n === max ? ' best' : ''}">
        <span class="hn">${n || ''}</span>
        <span class="hb"><i style="height:${max ? (n / max) * 100 : 0}%"></i></span>
        <span class="hh">${h}</span>
      </div>`;
    }
    html += `<div class="agg"><div class="agghd">🕐 시간대별 가능 인원</div>`
      + `<div class="hchart">${cols}</div>`
      + `<div class="sub" style="text-align:right; margin-top:4px; font-size:.72rem;">시(時)</div>`
      + `</div>`;
  }
  if (reasons.length) {
    html += `<div class="agg"><div class="agghd">🚫 등록된 일정</div>`
      + reasons.map(([t, n]) => `<div class="rsn"><span class="t">${esc(t)}</span><span class="n">${n}명</span></div>`).join('')
      + `</div>`;
  }
  $('#dsAgg').innerHTML = html;
}

// 정기전 등록/수정 (팀장 — 사이트 전체 관리자와는 다른 권한이다)
async function saveEvent(){
  if (!isTeamLeader || !currentTeam) return;
  const key = openKey;
  const raw = $('#dsRound').value.trim();
  const round = raw === '' ? null : parseInt(raw, 10);
  if (raw !== '' && (!Number.isFinite(round) || round < 1)) return msg('회차는 1 이상의 숫자로 입력해 주세요.', 'err');
  const note = $('#dsNote').value.trim() || null;
  msg('저장 중...');
  try {
    const rows = await sbFetch('/rest/v1/club_events?on_conflict=team_id,event_date', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ team_id: currentTeam, event_date: key, round_no: round, note })
    });
    if (!rows || !rows.length) throw new Error('권한이 없습니다. 팀장만 등록할 수 있습니다.');
    events[key] = rows[0];
    updateMonthCache();
    render();
    openDay(key);              // 시트 내용 갱신 — msg 를 지우므로 안내는 그 뒤에 띄운다
    msg('정기전을 저장했습니다.', 'ok');
  } catch(e){ msg('저장 실패: ' + (e.message || '알 수 없는 오류'), 'err'); }
}

async function delEvent(){
  if (!isTeamLeader || !currentTeam) return;
  const key = openKey;
  if (!events[key]) return;
  if (!confirm(`${label(key)} 정기전 기록을 지울까요?`)) return;
  msg('삭제 중...');
  try {
    await sbFetch(`/rest/v1/club_events?team_id=eq.${currentTeam}&event_date=eq.${key}`, { method: 'DELETE' });
    delete events[key];
    updateMonthCache();
    render();
    openDay(key);
    msg('삭제했습니다.', 'ok');
  } catch(e){ msg('삭제 실패: ' + (e.message || '알 수 없는 오류'), 'err'); }
}

// ══ 소속 팀 스위처 ══
function renderTeamBar(){
  const bar = $('#teamBar'), sel = $('#teamSel');
  if (!bar || !sel) return;
  if (!getAuth()) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (!myTeams.length) {
    sel.innerHTML = '<option value="">소속 팀 없음</option>';
    sel.disabled = true;
  } else {
    sel.innerHTML = myTeams.map(t =>
      `<option value="${esc(t.id)}"${t.id === currentTeam ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    sel.disabled = myTeams.length < 2;
  }
  sel.onchange = async () => {
    if (!sel.value) return;
    currentTeam = sel.value; tSet(currentTeam);
    const me = myTeams.find(t => t.id === currentTeam);
    isTeamLeader = !!(me && me.is_admin);
    await refresh();
  };
}

// ══ 설정 모달 ══
const { open: openTeamModal } = initTeamModal({
  getAuth,
  getCurrentTeam: () => currentTeam,
  setCurrentTeam: id => { currentTeam = id; tSet(currentTeam); },
  getMyTeams: () => myTeams,
  reloadTeams: loadTeams,
  afterChange: async () => { renderTeamBar(); await refresh(); }
});

(function initSettings(){
  const modal = $('#setModal');
  const themeBtns = modal.querySelectorAll('#setTheme button');
  const sync = () => {
    const t = getTheme();
    themeBtns.forEach(b => b.classList.toggle('on', b.dataset.t === t));
  };
  $('#btnSettings').onclick = () => { sync(); modal.classList.add('on'); };
  $('#setClose').onclick = () => modal.classList.remove('on');
  modal.onclick = e => { if (e.target === modal) modal.classList.remove('on'); };
  themeBtns.forEach(b => b.onclick = () => {
    try { localStorage.setItem(LS_THEME, b.dataset.t); } catch(e){}
    applyTheme(b.dataset.t); sync();
  });
  $('#setTeam').onclick = () => { modal.classList.remove('on'); openTeamModal(); };
})();

$('#dsClose').onclick = () => $('#daySheet').classList.remove('on');
$('#daySheet').onclick = e => { if (e.target.id === 'daySheet') $('#daySheet').classList.remove('on'); };
$('#dsO').onclick = () => vote('o');
$('#dsX').onclick = () => vote('x');
$('#dsRangeSave').onclick = saveRange;
$('#dsSave').onclick = saveEvent;
$('#dsDel').onclick = delEvent;

$('#btnLogout').onclick = () => {
  if (!confirm('로그아웃할까요?')) return;
  try { localStorage.removeItem(LS_AUTH); localStorage.removeItem(LS_TEAM); } catch(e){}
  location.href = '../score/';
};

// 다른 부원이 투표한 건 서버에만 쌓이므로, 화면으로 돌아올 때 다시 읽어 온다.
// (앱을 켜 둔 채로도 최신 인원수를 보게 된다. 폴링은 하지 않는다)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentTeam) refresh(true);
});

// ══ 시작 ══
applyTheme(getTheme());
registerSW();
buildWheel($('#dsFrom'), FROM_OPTS, () => { syncToWheelState(); saveHours(); });
buildWheel($('#dsTo'), TO_OPTS, saveHours);
(async () => {
  $('#view').innerHTML = '<div class="card"><div class="empty">불러오는 중...</div></div>';
  if (getAuth()) $('#btnLogout').style.display = '';
  await loadTeams();
  renderTeamBar();
  await refresh();
})();
