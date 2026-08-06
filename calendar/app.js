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
let isTeamAdmin = false;

// 보고 있는 달 (1일 기준)
let cur = new Date(); cur.setDate(1); cur.setHours(0, 0, 0, 0);

// 이번 달 데이터 — 모두 'YYYY-MM-DD' 를 키로 쓴다
let events = {};    // 날짜 → { id, round_no, note }
let gameCnt = {};   // 날짜 → 경기 판수
let counts = {};    // 날짜 → { o, x }
let myVote = {};    // 날짜 → 'o' | 'x'
let loading = false;

// ── 날짜 유틸 (로컬 시간 기준. toISOString 은 UTC 라 하루 밀릴 수 있어 쓰지 않는다) ──
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const todayStr = () => ymd(new Date());
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
// 지난 날짜엔 투표할 수 없다 (이미 지나간 날의 참여 여부를 받을 이유가 없다).
// 키가 'YYYY-MM-DD' 라 문자열 비교로 충분하다.
const isPast = key => key < todayStr();
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
  isTeamAdmin = !!(me && me.is_admin);
}

// 이번 달의 첫날/마지막날 (문자열)
function monthRange(){
  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const last  = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
  return [ymd(first), ymd(last)];
}

async function loadMonth(){
  events = {}; gameCnt = {}; counts = {}; myVote = {};
  if (!currentTeam) return;
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
      ? sbFetch(`/rest/v1/day_votes?select=vote_date,choice&team_id=eq.${currentTeam}`
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

  if (cnt.status === 'fulfilled' && Array.isArray(cnt.value))
    for (const c of cnt.value) counts[c.vote_date] = { o: c.o_cnt || 0, x: c.x_cnt || 0 };

  // day_votes 는 RLS 상 '내 행'만 돌아온다 — 그래서 이게 곧 내 표다
  if (mine.status === 'fulfilled' && Array.isArray(mine.value))
    for (const v of mine.value) myVote[v.vote_date] = v.choice;
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

  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div class="cell pad"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${pad(m + 1)}-${pad(d)}`;
    const dow = new Date(y, m, d).getDay();
    const ev = events[key], g = gameCnt[key], c = counts[key] || { o: 0, x: 0 }, mv = myVote[key];
    const cls = ['cell'];
    if (key === today) cls.push('today');
    if (mv) cls.push('mine');
    if (key < today) cls.push('past');   // 투표 불가 — 눌러서 정기전·판수는 볼 수 있다
    const dcls = dow === 0 ? ' sun' : dow === 6 ? ' sat' : '';
    cells += `<div class="${cls.join(' ')}" data-d="${key}">
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

  view.innerHTML = `
    <div class="monthbar">
      <button class="mbtn" id="prevM" aria-label="이전 달">‹</button>
      <b>${y}년 ${m + 1}월</b>
      <button class="mbtn" id="nextM" aria-label="다음 달">›</button>
    </div>
    <div style="text-align:center; margin-bottom:14px;">
      <button class="todaybtn" id="goToday">오늘로</button>
    </div>
    <div class="dow">${DOW.map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
    <div class="grid" id="grid">${cells}</div>
    <div class="sub" style="text-align:center; margin:14px 0 20px;">
      날짜를 눌러 참여 가능 여부를 남기세요. 누가 골랐는지는 공개되지 않습니다.
    </div>
    ${topDaysHtml()}
  `;

  $('#prevM').onclick = () => moveMonth(-1);
  $('#nextM').onclick = () => moveMonth(1);
  $('#goToday').onclick = () => {
    const n = new Date(); n.setDate(1); n.setHours(0,0,0,0);
    if (n.getTime() === cur.getTime()) return;
    cur = n; refresh();
  };
  document.querySelectorAll('#grid .cell[data-d]').forEach(el => {
    el.onclick = () => openDay(el.dataset.d);
  });
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

function moveMonth(delta){
  cur = new Date(cur.getFullYear(), cur.getMonth() + delta, 1);
  refresh();
}

async function refresh(){
  if (loading) return;
  loading = true;
  try { await loadMonth(); } finally { loading = false; }
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

  // 지난 날짜는 투표 칸을 닫는다. 정기전·판수·인원수는 그대로 볼 수 있다.
  const past = isPast(key);
  $('#dsVoteBox').style.display = past ? 'none' : '';
  $('#dsPastNote').style.display = past ? '' : 'none';
  syncVoteUI();
  $('#dsCntO').textContent = c.o;
  $('#dsCntX').textContent = c.x;

  const adm = $('#dsAdm');
  adm.style.display = isTeamAdmin ? 'block' : 'none';
  if (isTeamAdmin) {
    $('#dsRound').value = ev && ev.round_no != null ? ev.round_no : '';
    $('#dsNote').value = ev && ev.note ? ev.note : '';
    $('#dsDel').style.display = ev ? '' : 'none';
  }
  msg('');
  $('#daySheet').classList.add('on');
}

function syncVoteUI(){
  const mv = myVote[openKey];
  $('#dsO').classList.toggle('on', mv === 'o');
  $('#dsX').classList.toggle('on', mv === 'x');
  $('#dsC').classList.toggle('on', !mv);
}

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
  const prev = myVote[key];
  const next = (choice && choice !== prev) ? choice : null;

  // 낙관적 반영: 숫자를 먼저 움직여 두고, 실패하면 되돌린다
  const c = counts[key] || (counts[key] = { o: 0, x: 0 });
  if (prev) c[prev] = Math.max(0, c[prev] - 1);
  if (next) c[next] = (c[next] || 0) + 1;
  if (next) myVote[key] = next; else delete myVote[key];
  syncVoteUI();
  $('#dsCntO').textContent = c.o;
  $('#dsCntX').textContent = c.x;
  msg('저장 중...');

  try {
    if (next) {
      await sbFetch('/rest/v1/day_votes?on_conflict=team_id,vote_date,user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ team_id: currentTeam, vote_date: key, user_id: auth.uid, choice: next, updated_at: new Date().toISOString() })
      });
    } else {
      await sbFetch(`/rest/v1/day_votes?team_id=eq.${currentTeam}&vote_date=eq.${key}&user_id=eq.${auth.uid}`,
        { method: 'DELETE' });
    }
    msg(next ? (next === 'o' ? '가능으로 저장했습니다.' : '불가로 저장했습니다.') : '표를 취소했습니다.', 'ok');
    render();
  } catch(e){
    // 되돌리기
    if (next) c[next] = Math.max(0, c[next] - 1);
    if (prev) c[prev] = (c[prev] || 0) + 1;
    if (prev) myVote[key] = prev; else delete myVote[key];
    syncVoteUI();
    $('#dsCntO').textContent = c.o;
    $('#dsCntX').textContent = c.x;
    msg('저장하지 못했습니다: ' + (e.message || '알 수 없는 오류'), 'err');
  }
}

// 정기전 등록/수정 (관리자)
async function saveEvent(){
  if (!isTeamAdmin || !currentTeam) return;
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
    if (!rows || !rows.length) throw new Error('권한이 없습니다. 팀 관리자만 등록할 수 있습니다.');
    events[key] = rows[0];
    render();
    openDay(key);              // 시트 내용 갱신 — msg 를 지우므로 안내는 그 뒤에 띄운다
    msg('정기전을 저장했습니다.', 'ok');
  } catch(e){ msg('저장 실패: ' + (e.message || '알 수 없는 오류'), 'err'); }
}

async function delEvent(){
  if (!isTeamAdmin || !currentTeam) return;
  const key = openKey;
  if (!events[key]) return;
  if (!confirm(`${label(key)} 정기전 기록을 지울까요?`)) return;
  msg('삭제 중...');
  try {
    await sbFetch(`/rest/v1/club_events?team_id=eq.${currentTeam}&event_date=eq.${key}`, { method: 'DELETE' });
    delete events[key];
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
    isTeamAdmin = !!(me && me.is_admin);
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
$('#dsC').onclick = () => vote(null);
$('#dsSave').onclick = saveEvent;
$('#dsDel').onclick = delEvent;

$('#btnLogout').onclick = () => {
  if (!confirm('로그아웃할까요?')) return;
  try { localStorage.removeItem(LS_AUTH); localStorage.removeItem(LS_TEAM); } catch(e){}
  location.href = '../score/';
};

// ══ 시작 ══
applyTheme(getTheme());
registerSW();
(async () => {
  $('#view').innerHTML = '<div class="card"><div class="empty">불러오는 중...</div></div>';
  if (getAuth()) $('#btnLogout').style.display = '';
  await loadTeams();
  renderTeamBar();
  await refresh();
})();
