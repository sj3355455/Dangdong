import { sbFetch } from './supabase.js';
import { registerSW, getTheme, applyTheme, LS_THEME, initTeamModal } from './common.js';

let DATA = { updated: '', players: [], games: [] };
let RAW_GAMES = [];
let RAW_MEMBERS = [];
let rankPeriod = '이번달';
let gamesMode = '통합';

// ── 소속 팀 컨텍스트 (점수판과 localStorage 공유) ──
const LS_TEAM = 'dangCurrentTeam';
const tGet = () => { try { return JSON.parse(localStorage.getItem(LS_TEAM)); } catch(e){ return null; } };
const tSet = v => { try { localStorage.setItem(LS_TEAM, JSON.stringify(v)); } catch(e){} };
let myTeams = [];
let currentTeam = tGet();   // 현재 팀 id (없으면 전역 폴백)

function getFilteredData(period) {
  let games = RAW_GAMES;
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const todayStr = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate());
  const monthStr = now.getFullYear() + '-' + pad(now.getMonth()+1);

  if (period === '오늘') {
    games = RAW_GAMES.filter(g => {
      const dt = new Date(g.played_at);
      const dateStr = dt.getFullYear() + '-' + pad(dt.getMonth()+1) + '-' + pad(dt.getDate());
      return dateStr === todayStr;
    });
  } else if (period === '이번달') {
    games = RAW_GAMES.filter(g => {
      const dt = new Date(g.played_at);
      const dateStr = dt.getFullYear() + '-' + pad(dt.getMonth()+1);
      return dateStr === monthStr;
    });
  }
  return processData(games, RAW_MEMBERS);
}

const SB_URL = 'https://ezwassqurbmzcjfmtjop.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6d2Fzc3F1cmJtemNqZm10am9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjMxOTIsImV4cCI6MjA5OTc5OTE5Mn0.O6eHOO4-yxW7HVmNVjOkakrcoEeF5tORylhG1j79BeU';
const LS_AUTH = 'dangScoreAuth';

async function fetchGames() {
  if (!currentTeam) return []; // 소속 팀이 없는 사용자는 다른 팀의 게임 정보를 조회하지 않음
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  try {
    const auth = getAuth();
    if (auth && auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
  } catch(e) {}
  
  let url = SB_URL + '/rest/v1/games?select=id,played_at,players&order=played_at.asc';
  url += '&team_id=eq.' + currentTeam;   // 현재 팀 게임만 (위에서 currentTeam 없으면 이미 반환)
  const res = await fetch(url, { headers: headers });
  if (!res.ok) throw new Error('fetch error');
  return await res.json();
}

// 내 소속 팀 로드 + 현재 팀 확정 (실패 시 전역 폴백)
async function loadTeams(){
  const auth = getAuth();
  if (!auth || !auth.uid) { myTeams = []; renderTeamBar(); return; }
  try {
    const rows = await sbFetch('/rest/v1/rpc/my_teams', { method: 'POST', body: JSON.stringify({}) });
    myTeams = Array.isArray(rows) ? rows : [];
    const remembered = tGet();
    if (remembered && myTeams.some(t => t.id === remembered)) currentTeam = remembered;
    else currentTeam = myTeams[0] ? myTeams[0].id : null;
    tSet(currentTeam);
  } catch(e){ /* my_teams 미배포 등 → 전역 폴백 */ }
  renderTeamBar();
}

// 헤더 소속 팀 스위처
function renderTeamBar(){
  const bar = document.getElementById('teamBar');
  const sel = document.getElementById('teamSel');
  if (!bar || !sel) return;
  const auth = getAuth();
  if (!auth) { bar.style.display = 'none'; return; }
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
    const sub = document.getElementById('sub');
    if (sub) sub.textContent = '팀 전환 중...';
    await reloadData();
    const cur = document.querySelector('.tab.on') ? document.querySelector('.tab.on').dataset.v : 'rank';
    show(cur);
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
  };
}

// ══ 팀 설정 모달 — 공통 모듈(common.js)로 이동. 앱별 차이(콜백)만 주입. ══
const { open: openTeamModal } = initTeamModal({
  getAuth: () => getAuth(),
  getCurrentTeam: () => currentTeam,
  setCurrentTeam: id => { currentTeam = id; tSet(currentTeam); },
  getMyTeams: () => myTeams,
  reloadTeams: loadTeams,
  afterChange: async () => {
    await reloadData();
    const cur = document.querySelector('.tab.on') ? document.querySelector('.tab.on').dataset.v : 'rank';
    show(cur);
  }
});

async function fetchMembers() {
  if (!currentTeam) return []; // 소속 팀이 없으면 다른 팀의 회원 정보가 조회되지 않도록 격리
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  try {
    const auth = getAuth();
    if (auth && auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
  } catch(e) {}
  
  const res = await fetch(SB_URL + '/rest/v1/team_members?select=user_id,profiles(id,display_name,handicap)&team_id=eq.' + currentTeam, {
    headers: headers
  });
  if (!res.ok) throw new Error('fetch error');
  const rows = await res.json();
  // team_members 는 profiles 를 중첩해서 반환한다({user_id, profiles:{...}}).
  // processData 의 수지 매칭은 평탄한 {id, display_name, handicap} 구조를 기대하므로 평탄화한다.
  // (이걸 안 하면 매칭이 전부 실패해 프로필의 실제 수지가 반영되지 않고 0으로 남는다.)
  return (rows || []).map(r => (r && r.profiles) ? {
    id: r.profiles.id,
    display_name: r.profiles.display_name,
    handicap: r.profiles.handicap
  } : r).filter(Boolean);
}

// ══ 관리자 기능 ══
// 서버(RLS)가 실제 권한을 강제한다. 여기서는 UI 노출 여부만 판단.
let IS_ADMIN = false;
async function fetchAdmin(){
  const auth = getAuth();
  if (!auth || !auth.uid || !auth.token) return false;
  try {
    const d = await sbFetch('/rest/v1/profiles?select=is_admin&id=eq.' + auth.uid);
    return !!(d && d[0] && d[0].is_admin);
  } catch(e){ return false; }   // is_admin 컬럼이 아직 없으면 조용히 비활성화
}
// Prefer: return=representation — RLS에 막히면 빈 배열이 와서 실패를 감지할 수 있다
const REP = { headers: { Prefer: 'return=representation' } };
const adminApi = {
  updateGame: (id, players) => sbFetch('/rest/v1/games?id=eq.' + id, Object.assign({ method: 'PATCH', body: JSON.stringify({ players }) }, REP)),
  deleteGame: id => sbFetch('/rest/v1/games?id=eq.' + id, Object.assign({ method: 'DELETE' }, REP)),
  updateProfile: (id, fields) => sbFetch('/rest/v1/profiles?id=eq.' + id, Object.assign({ method: 'PATCH', body: JSON.stringify(fields) }, REP)),
  // 이름 변경을 한 번에: 프로필 + 그 사람이 뛴 모든 경기의 저장된 이름을 서버에서 갱신 (본인/관리자만)
  renamePlayer: (id, name, handicap) => sbFetch('/rest/v1/rpc/rename_player', { method: 'POST', body: JSON.stringify({ target: id, new_name: name, new_handicap: handicap }) })
};
async function reloadData(){
  RAW_GAMES = await fetchGames();
  RAW_MEMBERS = await fetchMembers().catch(() => RAW_MEMBERS);
  DATA = getFilteredData(rankPeriod);
}
const NO_PERM = '권한이 없습니다. 관리자 계정으로 로그인했는지 확인하세요.';

function attachGameAdmin(el, id){
  const raw = RAW_GAMES.find(r => String(r.id) === String(id));
  if (!raw) return;
  const F = [['rank','순위'],['score','점수'],['target','목표'],['innings','이닝'],['highRun','하이런'],['misses','공타'],['cushMade','쿠션성공'],['cushInn','쿠션시도']];
  const bar = $(`<div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🛠 관리자</h3>
    <div style="display:flex; gap:8px;">
      <button class="mbtn" id="gAdmEdit">✏️ 경기 수정</button>
      <button class="mbtn" id="gAdmDel" style="color:#e5484d;border-color:#e5484d">🗑 경기 삭제</button>
    </div>
    <div id="gAdmForm" style="display:none; margin-top:12px">
      <div class="scroll"><table>
        <thead><tr><th class="name">선수</th>${F.map(f=>`<th>${f[1]}</th>`).join('')}</tr></thead>
        <tbody>${raw.players.map((p,j)=>`<tr><td class="name">${esc(p.name||'')}</td>${
          F.map(f=>`<td><input data-j="${j}" data-k="${f[0]}" type="number" value="${p[f[0]] ?? 0}" style="width:64px;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px"></td>`).join('')
        }</tr>`).join('')}</tbody>
      </table></div>
      <div style="display:flex; gap:8px; margin-top:10px">
        <button class="mbtn on" id="gAdmSave">저장</button>
        <button class="mbtn" id="gAdmCancel">취소</button>
      </div>
      <div class="sub" style="margin-top:8px">순위를 바꾸면 우승(1위) 여부도 자동으로 맞춰집니다.</div>
    </div>
  </div>`);
  bar.querySelector('#gAdmEdit').onclick = () => {
    const f = bar.querySelector('#gAdmForm');
    f.style.display = f.style.display === 'none' ? '' : 'none';
  };
  bar.querySelector('#gAdmCancel').onclick = () => { bar.querySelector('#gAdmForm').style.display = 'none'; };
  bar.querySelector('#gAdmSave').onclick = async e => {
    const btn = e.target; btn.disabled = true;
    try {
      const np = raw.players.map(p => Object.assign({}, p));
      bar.querySelectorAll('#gAdmForm input').forEach(inp => {
        np[+inp.dataset.j][inp.dataset.k] = parseInt(inp.value, 10) || 0;
      });
      np.forEach(p => { p.win = p.rank === 1; });
      const d = await adminApi.updateGame(raw.id, np);
      if (!d || !d.length) throw new Error(NO_PERM);
      await reloadData();
      alert('경기 기록이 수정되었습니다.');
      showGame(id);
    } catch(err){ alert('수정 실패: ' + err.message); btn.disabled = false; }
  };
  bar.querySelector('#gAdmDel').onclick = async () => {
    if (!confirm('이 경기를 완전히 삭제할까요? 되돌릴 수 없습니다.')) return;
    try {
      const d = await adminApi.deleteGame(raw.id);
      if (!d || !d.length) throw new Error(NO_PERM);
      await reloadData();
      alert('경기가 삭제되었습니다.');
      show('games');
    } catch(err){ alert('삭제 실패: ' + err.message); }
  };
  el.appendChild(bar);
}

function processData(games, members) {
  const pmap = {};
  const dataGames = [];
  // 이름은 경기에 저장된 값을 그대로 쓴다. (이름 변경 시 rename_player 함수가
  //  프로필과 모든 경기의 저장 이름을 한 번에 갱신하므로 매번 매칭할 필요가 없다.)

  for (const g of (games || [])) {
    if (!g) continue;
    const dt = new Date(g.played_at);
    const pad = n => String(n).padStart(2, '0');
    const dateStr = dt.getFullYear() + '-' + pad(dt.getMonth()+1) + '-' + pad(dt.getDate());
    const datetimeStr = dateStr + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
    const pls = Array.isArray(g.players) ? g.players : [];
    const isTeam = pls.length > 0 && pls[0].isTeam;
    const typeStr = isTeam ? '팀전' : (pls.length + '인');
    const nameStr = typeStr;

    dataGames.unshift({
      id: String(g.id || datetimeStr),
      date: dateStr,
      datetime: datetimeStr,
      type: typeStr,
      name: nameStr,
      players: pls.map(p => ({
        name: p.name || p.id || "알 수 없음", ranking: p.win ? 1 : 2,
        rank: p.rank != null ? p.rank : (p.win ? 1 : 2),
        timeMs: p.timeMs ?? p.time_ms ?? 0,
        target: p.target, score: p.score, innings: p.innings,
        highRun: p.highRun ?? p.high_run ?? 0, misses: p.misses ?? 0, cushMade: p.cushMade ?? p.cush_made ?? 0, cushInn: p.cushInn ?? p.cush_inn ?? 0
      }))
    });

    // 게임 내 각 선수의 평균순위(분수). 동순위는 공동 점유 구간의 평균: 공동 2등 = 2.5, 공동 3등 = 3.5
    const ranks = pls.map(pp => (pp.rank != null ? pp.rank : (pp.win ? 1 : 2)));
    const fracRank = idx => {
      const r = ranks[idx]; let less = 0, eq = 0;
      for (const rr of ranks) { if (rr < r) less++; else if (rr === r) eq++; }
      return less + (eq + 1) / 2;
    };

    for (const p of pls) {
      const pName = p.name || p.id || "알 수 없음";
      // 회원은 계정 id로 묶어 이름이 바뀌어도 같은 사람으로 집계. 게스트는 이름으로 묶는다.
      const key = p.id ? ('id:' + p.id) : ('nm:' + pName);
      if (!pmap[key]) {
        pmap[key] = {
          name: pName,
          handicap: isTeam ? 0 : p.target,
          games: 0,
          wins: 0,
          modes: {},   // 모드별 집계: {'2인':{games,wins,rankSum}, '3인':..., '4인':..., '팀전':...}
          history: [],
          adjPtsSum: 0,
          id: p.id || null
        };
      }
      const st = pmap[key];
      if (!isTeam) st.handicap = Math.max(st.handicap, p.target);
      st.games++;
      if (p.win) st.wins++;

      const pIdx = g.players.indexOf(p);
      const pRank = fracRank(pIdx);
      
      let pt = 0;
      if (isTeam) {
        pt = (3.5 - pRank) / 2 * 100;
      } else {
        const N = g.players.length;
        if (N > 1) pt = (N - pRank) / (N - 1) * 100;
      }
      st.adjPtsSum += pt;

      const M = st.modes[typeStr] || (st.modes[typeStr] = { games: 0, wins: 0, rankSum: 0, adjPtsSum: 0 });
      M.games++;
      if (p.win) M.wins++;
      M.rankSum += pRank;
      M.adjPtsSum += pt;

      const opp = g.players.filter(x => (x.name || x.id) !== pName).map(x => x.name || x.id).join(', ');
      const innings = p.innings || p.turn_count || 0;
      const average = innings ? (p.score / innings) : 0;
      
      st.history.unshift({
        id: g.id,
        type: typeStr,
        rank: pRank,
        date: dateStr,
        opponents: opp,
        score: p.score,
        inning: innings,
        miss: p.misses ?? p.miss_count ?? 0,
        average: average,
        highRun: p.highRun ?? p.high_run ?? 0,
        cushMade: p.cushMade ?? p.cush_made ?? 0,
        cushInn: p.cushInn ?? p.cush_inn ?? 0,
        timeMs: p.timeMs ?? p.time_ms ?? 0,
        win: p.win,
        adjPt: pt
      });
    }
  }

  const pArr = Object.values(pmap);
  
  // Update handicap based on actual member info
  if (members && members.length > 0) {
    for (const p of pArr) {
      let m = p.id ? members.find(x => x.id === p.id) : null;
      if (!m) m = members.find(x => x.display_name === p.name);
      if (m) {
        // 이름은 경기에 저장된 값을 사용 (rename_player가 저장 시점에 갱신). 여기선 현재 수지만 반영.
        if (m.handicap != null) p.handicap = parseInt(m.handicap, 10);
      }
    }
  }

  for (const p of pArr) {
    p.winRate = p.games > 0 ? (p.wins / p.games) * 100 : 0;
    p.adjRate = p.games > 0 ? (p.adjPtsSum / p.games) : 0;

    for (const mk in p.modes) {
      const M = p.modes[mk];
      M.winRate = M.games > 0 ? (M.wins / M.games) * 100 : 0;
      M.avgRank = M.games > 0 ? (M.rankSum / M.games) : null;
      M.adjRate = M.games > 0 ? (M.adjPtsSum / M.games) : 0;
    }

    let sumInnings = 0;
    let sumScore = 0;
    let maxHr = 0;
    let totalMisses = 0;
    let cushMade = 0;
    let cushInn = 0;
    let sumTime = 0;        // 시간 기록이 있는 경기의 누적 소모 시간(ms)
    let sumShots = 0;       // 그 경기들의 샷(타석) 횟수 합 (평균 인터벌 분모)

    for (const h of p.history) {
      sumInnings += h.inning;
      sumScore += h.score;
      totalMisses += h.miss;
      if (h.highRun > maxHr) maxHr = h.highRun;
      cushMade += h.cushMade;
      cushInn += h.cushInn;
      if (h.timeMs > 0) {
        sumTime += h.timeMs;
        sumShots += Math.max(1, h.score + h.inning);
      }
    }

    p.avgAvg = sumInnings > 0 ? (sumScore / sumInnings) : 0;
    p.bestHr = maxHr;
    p.hitRate = sumInnings > 0 ? ((sumInnings - totalMisses) / sumInnings) * 100 : 0;
    // 평균 인터벌 = 1샷(타석) 당 평균 소모 시간(초). 공타/파울 횟수까지 포함하여 계산
    p.avgInterval = sumShots > 0 ? (sumTime / sumShots) / 1000 : null;
    // 쿠션 성공률 = 마무리 쿠션 성공 / 쿠션을 시도한 이닝. 시도가 없으면 null
    p.cushRate = cushInn > 0 ? (cushMade / cushInn) * 100 : null;
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return {
    updated: now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
    players: pArr,
    games: dataGames
  };
}

const $ = (h) => { const d=document.createElement('div'); d.innerHTML=h.trim(); return d.firstChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const getAuth = () => { try { return JSON.parse(localStorage.getItem(LS_AUTH)); } catch(e) { return null; } }

const COL_NAME = {k:'name', t:'이름', txt:1};
const COL_HDCP = {k:'handicap', t:'수지', fmt:v=>v ? v*10 : '—'};
const COLS_ALL = [   // 통합: 실력 지표 통합. 승수·승률 대신 보정 승률(준비 중)
  COL_NAME, COL_HDCP,
  {k:'games',    t:'경기'},
  {k:'adjRate',  t:'보정 승률',  fmt:v=>v.toFixed(1)+'%'},
  {k:'avgAvg',   t:'에버리지',   fmt:v=>v.toFixed(3)},
  {k:'hitRate',  t:'득점률',    fmt:v=>v.toFixed(1)+'%'},
  {k:'cushRate', t:'쿠션 성공률', fmt:v=>v.toFixed(1)+'%'},
  {k:'bestHr',   t:'하이런'},
  {k:'avgInterval', t:'평균 인터벌', fmt:v=>v.toFixed(1)+'초'},
];
const COLS_VS = [    // 2인 · 팀전: 두 진영 승부
  COL_NAME, COL_HDCP,
  {k:'games',   t:'경기'},
  {k:'wins',    t:'승'},
  {k:'winRate', t:'승률', fmt:v=>v.toFixed(0)+'%'},
];
const COLS_MULTI = [ // 3인 · 4인: 다자전
  COL_NAME, COL_HDCP,
  {k:'games',   t:'경기'},
  {k:'avgRank', t:'평균순위', fmt:v=>v.toFixed(2)+'등'},
  {k:'winRate', t:'승률(1등)', fmt:v=>v.toFixed(0)+'%'},
];
const MODE_TABS = ['통합','2인','3인','4인','팀전'];
const colsFor = m => m==='통합' ? COLS_ALL : (m==='2인'||m==='팀전') ? COLS_VS : COLS_MULTI;
const defSort = m => m==='통합' ? 'avgAvg' : 'winRate';
const cell = (p, c) => p[c.k]==null ? '—' : (c.fmt ? c.fmt(p[c.k]) : p[c.k]);
let rankMode='통합', sortKey='avgAvg', sortAsc=false;

function rankRows(mode){
  if(mode==='통합') return DATA.players.filter(p=>p.games>0 && p.id);
  return DATA.players
    .filter(p=>p.modes[mode] && p.modes[mode].games>0 && p.id)
    .map(p=>({name:p.name, handicap:p.handicap, ...p.modes[mode]}));
}

function renderRank(){
  const COLS = colsFor(rankMode);
  if(!COLS.some(c=>c.k===sortKey)) sortKey = defSort(rankMode);
  const rows = rankRows(rankMode).sort((a,b)=>{
    let x=a[sortKey], y=b[sortKey], r;
    if(x==null && y==null) return 0;
    if(x==null) return 1;
    if(y==null) return -1;
    if(typeof x==='string') r = x.localeCompare(y,'ko');
    else r = x-y;
    if(r===0) r = (b.avgAvg||0)-(a.avgAvg||0);
    return sortAsc ? r : -r;
  });
  
  const periods = ['오늘', '이번달', '통산'];
  const periodSel = `<select class="field p-period" style="width:110px; padding:6px; font-size:0.95rem; border-radius:8px; margin:0;">` + 
    periods.map(p => `<option value="${p}" ${p===rankPeriod?'selected':''}>${p}</option>`).join('') + 
    `</select>`;

  const modeSel = `<select class="field p-mode" style="width:110px; padding:6px; font-size:0.95rem; border-radius:8px; margin:0;">` + 
    MODE_TABS.map(m => `<option value="${m}" ${m===rankMode?'selected':''}>${m}</option>`).join('') + 
    `</select>`;

  const head = COLS.map(c=>{
    const on = c.k===sortKey;
    const ar = on ? (sortAsc?'▲':'▼') : '↕';
    return `<th class="${on?'on':''} ${c.txt?'name':''}" data-k="${c.k}">${c.t} <span class="ar">${ar}</span></th>`;
  }).join('');
  let inner;
  if(rows.length===0){
    inner = `<div class="empty">아직 ${rankMode==='통합'?'':rankMode+'전 '}기록이 없습니다</div>`;
  } else {
    const body = rows.map((p,i)=>{
      const medal = ['🥇','🥈','🥉'][i] || (i+1);
      const tds = COLS.map(c=>{
        if(c.k==='name') return `<td class="name"><a class="pl" data-p="${esc(p.name)}">${esc(p.name)}</a></td>`;
        return `<td>${cell(p, c)}</td>`;
      }).join('');
      return `<tr><td class="rk">${medal}</td>${tds}</tr>`;
    }).join('');
    inner = `<div class="scroll"><table><thead><tr><th class="rk"></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  const note = rankMode==='통합'
    ? '표 제목을 누르면 그 기준으로 정렬됩니다. · <b>보정 승률</b>은 모드별로 인원수를 고려하여 공정하게 환산한 승점 평균입니다 (50%가 평균).'
    : (rankMode==='3인'||rankMode==='4인')
      ? '표 제목을 누르면 정렬됩니다. · <b>평균순위</b>는 동순위를 분수로 계산합니다(공동 2등 = 2.5등).'
      : '표 제목을 누르면 그 기준으로 정렬됩니다.';
  const el = $(`<div class="card">
      <div style="display:flex; gap:8px; margin-bottom:14px;">
        ${periodSel}
        ${modeSel}
      </div>
      ${inner}
      <div class="sub" style="margin:10px 0 0">${note}</div></div>`);
  
  el.querySelector('.p-period').onchange = (e) => {
    rankPeriod = e.target.value;
    DATA = getFilteredData(rankPeriod);
    const sub = document.getElementById('sub');
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
    show('rank');
  };

  el.querySelector('.p-mode').onchange = (e) => {
    rankMode = e.target.value;
    sortKey = defSort(rankMode);
    sortAsc = false;
    show('rank');
  };
  el.querySelectorAll('th[data-k]').forEach(th=>th.onclick=()=>{
    const k = th.dataset.k;
    if(k===sortKey) sortAsc=!sortAsc; else { sortKey=k; sortAsc = (k==='name'||k==='avgRank'); }
    show('rank');
  });
  el.querySelectorAll('a.pl').forEach(a=>a.onclick=()=>showPlayer(a.dataset.p));
  return el;
}

function chart(vals, labels, opt){
  opt = opt || {};
  if(vals.length<2) return '<div class="empty">경기 2개 이상부터 그래프가 표시됩니다</div>';
  const dec = opt.dec==null ? 2 : opt.dec;
  const suf = opt.suffix || '';
  const fmt = v => (+v.toFixed(dec)) + suf;

  const availW = Math.max(260, Math.round(opt.W || 680));
  const H = opt.H || (availW < 420 ? 300 : availW < 560 ? 270 : 240);
  const P = {t:20, r:14, b:34, l:44};

  const MIN_GAP = 46;
  const needW = P.l + P.r + MIN_GAP*(vals.length-1);
  const W = Math.max(availW, needW);

  const iw=W-P.l-P.r, ih=H-P.t-P.b;
  const isInv = opt.invert || false;
  const min = opt.min != null ? opt.min : (isInv ? Math.min(...vals)*0.9 : 0);
  const max = opt.max != null ? opt.max : (Math.max(...vals)*1.15 || 1);
  const range = max - min || 1;

  const x = i => P.l + (vals.length===1?iw/2:iw*i/(vals.length-1));
  const y = v => isInv ? P.t + ((v - min)/range)*ih : P.t + ih - ((v - min)/range)*ih;

  const gap = iw/(vals.length-1);
  const showVal = gap >= 36;
  const xStep = Math.max(1, Math.ceil(34/gap));

  let g='';
  for(let i=0;i<=4;i++){
    const yy=P.t+ih*i/4;
    const v = isInv ? min + (range*i/4) : min + (range*(4-i)/4);
    g+=`<line x1="${P.l}" y1="${yy}" x2="${W-P.r}" y2="${yy}" stroke="var(--line)" stroke-width="1"/>`;
    g+=`<text x="${P.l-8}" y="${yy+4}" fill="var(--muted)" font-size="11" text-anchor="end">${fmt(v)}</text>`;
  }
  const pts = vals.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  const dots = vals.map((v,i)=>{
    const c = `<circle cx="${x(i)}" cy="${y(v)}" r="${showVal?4:3}" fill="var(--accent)"/>`;
    if(!showVal) return c;
    return c + `<text x="${x(i)}" y="${y(v)-10}" fill="var(--text)" font-size="11" text-anchor="middle">${fmt(v)}</text>`;
  }).join('');
  const xs = labels.map((l,i)=> i%xStep===0 ?
    `<text x="${x(i)}" y="${H-12}" fill="var(--muted)" font-size="10" text-anchor="middle">${esc(l)}</text>`:'').join('');
  return `<div class="cscroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${g}
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5"
      stroke-linejoin="round" stroke-linecap="round"/>${dots}${xs}</svg></div>`;
}

const METRICS = [
  {k:'avg', t:'에버리지', modes:['통합'], dec:2},
  {k:'hit', t:'득점률', modes:['통합'], max:100, suffix:'%', dec:0},
  {k:'adj', t:'보정 승률', modes:['통합'], max:100, suffix:'%', dec:1},
  {k:'games', t:'경기 수', modes:['통합'], dec:0},
  {k:'cush', t:'쿠션 성공률', modes:['통합'], max:100, suffix:'%', dec:0},
  {k:'hr', t:'하이런', modes:['통합'], dec:0},
  {k:'winRate', t:'승률', modes:['2인','팀전'], max:100, suffix:'%', dec:0},
  {k:'avgRank', t:'평균 순위', modes:['3인','4인'], dec:1, invert:true, min:1, max:4}
];

function calcStatsForHistory(h) {
  let games = h.length;
  let wins = h.filter(r => r.win).length;
  let sumInnings = 0, sumScore = 0, totalMisses = 0, maxHr = 0, cushMade = 0, cushInn = 0, sumTime = 0, sumShots = 0, sumAdjPt = 0, rankSum = 0;
  
  h.forEach(r => {
    sumInnings += (r.inning || 0);
    sumScore += (r.score || 0);
    totalMisses += (r.miss || 0);
    if ((r.highRun || 0) > maxHr) maxHr = r.highRun;
    cushMade += (r.cushMade || 0);
    cushInn += (r.cushInn || 0);
    sumAdjPt += (r.adjPt || 0);
    rankSum += (r.rank || 0);
    if (r.timeMs > 0) {
      sumTime += r.timeMs;
      sumShots += Math.max(1, r.score + r.inning);
    }
  });

  return {
    games,
    wins,
    winRate: games > 0 ? (wins / games) * 100 : 0,
    avgAvg: sumInnings > 0 ? (sumScore / sumInnings) : 0,
    bestHr: maxHr,
    hitRate: sumInnings > 0 ? ((sumInnings - totalMisses) / sumInnings) * 100 : 0,
    cushRate: cushInn > 0 ? (cushMade / cushInn) * 100 : null,
    avgInterval: sumShots > 0 ? (sumTime / sumShots) / 1000 : null,
    avgRank: games > 0 ? (rankSum / games) : null,
    adjRate: games > 0 ? (sumAdjPt / games) : 0
  };
}

function showPlayer(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  const auth = getAuth();
  if(auth && name === auth.name) {
    const btn = document.getElementById('btnMyRec');
    if(btn) btn.classList.add('on');
  }
  let p = DATA.players.find(v=>v.name===name);
  if (!p) p = { name, id: null, handicap: 0, total_games: 0, win_rate: 0, avg: 0, hr: 0 };
  let playerMode = '통합';
  let chartCur = 'avg';
  let chartGroup = 'day';
  let playerPeriod = rankPeriod;

  const el = $(`<div>
    <button class="back">← 순위로</button>
    <div class="card">
      <h2 style="margin:0">${esc(p.name)}</h2>
      <div class="sub" style="margin:2px 0 10px">수지 ${p.handicap * 10}</div>
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        <select class="field pd-period" style="width:110px; padding:6px; font-size:0.95rem; border-radius:8px; margin:0;">
          ${['오늘', '이번달', '통산'].map(pd=>`<option value="${pd}" ${pd===playerPeriod?'selected':''}>${pd}</option>`).join('')}
        </select>
        <select class="field ptab" style="width:110px; padding:6px; font-size:0.95rem; border-radius:8px; margin:0;">
          ${MODE_TABS.map(m=>`<option value="${m}" ${m===playerMode?'selected':''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="stats" id="pStats"></div>
      <div id="chartArea">
        <div class="chead" style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:4px;">
          <div style="flex:1;">
            <h3 style="font-size:1rem;margin:0 0 6px 0">📈 추이</h3>
            <select id="pMetricSel" class="field" style="width:140px; padding:6px; font-size:0.9rem"></select>
          </div>
        </div>
        <div class="sub" id="cdesc" style="margin:0 0 6px"></div>
        <div id="cbox"></div>
      </div>
    </div>
    <div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🗒️ 경기 이력</h3>
      <div class="scroll"><table>
        <thead><tr><th class="name">날짜</th><th class="name">상대</th><th>점수</th>
          <th>이닝</th><th>에버</th><th>하이런</th><th>결과</th></tr></thead>
        <tbody id="pHist"></tbody></table></div></div>
  </div>`);

  el.querySelector('.back').onclick=()=>show('rank');
  let lastW = 0;

  const renderMode = () => {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayStr = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate());
    const monthStr = now.getFullYear() + '-' + pad(now.getMonth()+1);

    let hPeriod = [...p.history];
    if (playerPeriod === '오늘') {
      hPeriod = hPeriod.filter(r => r.date === todayStr);
    } else if (playerPeriod === '이번달') {
      hPeriod = hPeriod.filter(r => r.date.startsWith(monthStr));
    }

    const h = playerMode === '통합' ? hPeriod : hPeriod.filter(r => r.type === playerMode);

    if (h.length === 0) {
      el.querySelector('#pStats').innerHTML = '<div class="empty" style="width:100%; text-align:center; padding: 20px 0; color:var(--muted)">이 기간 동안 치러진 경기가 없습니다.</div>';
      el.querySelector('#chartArea').style.display = 'none';
      el.querySelector('#pHist').innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted)">기록 없음</td></tr>';
      return;
    }

    const COLS = colsFor(playerMode).filter(c => c.k !== 'name' && c.k !== 'handicap');
    const stObj = calcStatsForHistory(h);
    
    let statsHtml = '';
    COLS.forEach(c => {
      statsHtml += `<div class="st"><div class="k">${c.t}</div><div class="v">${cell(stObj, c)}</div></div>`;
    });
    el.querySelector('#pStats').innerHTML = statsHtml;

    el.querySelector('#pHist').innerHTML = [...h].reverse().map(r=>`<tr onclick="showGame('${r.id}')" style="cursor:pointer">
      <td class="name">${esc(r.date)}</td><td class="name">${esc(r.opponents)}</td>
      <td>${r.score}</td><td>${r.inning}</td><td>${+r.average.toFixed(3)}</td>
      <td>${r.highRun}</td><td>${r.win?'<span class="win">🏆</span>':'—'}</td></tr>`).join('');

    el.querySelector('#chartArea').style.display = 'block';
    if (playerPeriod === '오늘') {
      chartGroup = 'game';
    } else if (playerPeriod === '이번달') {
      chartGroup = 'day';
    } else {
      chartGroup = 'month';
    }

      const availableMetrics = METRICS.filter(m => m.modes.includes(playerMode));
      el.querySelector('#pMetricSel').innerHTML = availableMetrics.map(m => `<option value="${m.k}">${m.t}</option>`).join('');
      
      if (!availableMetrics.find(m => m.k === chartCur)) {
        chartCur = availableMetrics[0].k;
      }
      el.querySelector('#pMetricSel').value = chartCur;

      el.querySelector('#pMetricSel').onchange = (e) => {
        chartCur = e.target.value;
        const currentH = playerMode === '통합' ? [...hPeriod] : hPeriod.filter(r => r.type === playerMode);
        draw(chartCur, currentH);
      };

      draw(chartCur, h);
  };

  const draw = (key, h) => {
    chartCur = key;
    const m = METRICS.find(v=>v.k===key);
    const box = el.querySelector('#cbox');
    lastW = box.clientWidth || innerWidth-64;

    const hAsc = [...h].reverse();
    const groups = {}; 
    
    hAsc.forEach((r, idx) => {
      const gKey = chartGroup === 'game' ? (idx + 1) + '경기' : chartGroup === 'day' ? r.date.substring(5, 10) : r.date.substring(0, 7);
      if (!groups[gKey]) groups[gKey] = { games: 0, sumInning: 0, sumScore: 0, sumMiss: 0, sumAdjPt: 0, maxHr: 0, cushMade: 0, cushInn: 0, wins: 0, rankSum: 0 };
      groups[gKey].games++;
      groups[gKey].sumInning += (r.inning || 0);
      groups[gKey].sumScore += (r.score || 0);
      groups[gKey].sumMiss += (r.miss || 0);
      groups[gKey].sumAdjPt += (r.adjPt || 0);
      if ((r.highRun || 0) > groups[gKey].maxHr) groups[gKey].maxHr = r.highRun;
      if (r.cushInn > 0) {
         groups[gKey].cushMade += (r.cushMade || 0);
         groups[gKey].cushInn += r.cushInn;
      }
      if (r.win) groups[gKey].wins++;
      if (r.rank) groups[gKey].rankSum += r.rank;
    });

    const labels = Object.keys(groups);
    const vals = labels.map(lbl => {
      const g = groups[lbl];
      if (key === 'avg') return g.sumInning ? g.sumScore / g.sumInning : 0;
      if (key === 'hit') return g.sumInning ? (g.sumInning - g.sumMiss) / g.sumInning * 100 : 0;
      if (key === 'adj') return g.games ? g.sumAdjPt / g.games : 0;
      if (key === 'games') return g.games;
      if (key === 'hr') return g.maxHr;
      if (key === 'cush') return g.cushInn ? (g.cushMade / g.cushInn) * 100 : 0;
      if (key === 'winRate') return g.games ? (g.wins / g.games) * 100 : 0;
      if (key === 'avgRank') return g.games ? (g.rankSum / g.games) : 0;
      return 0;
    });

    box.innerHTML = chart(vals, labels, {...m, W: lastW});
    
    const groupText = chartGroup === 'game' ? '경기별' : chartGroup === 'day' ? '일별' : '월별';
    let desc = m.t;
    if (key === 'avg') desc = `해당 ${groupText} 평균 에버리지 (총 득점 / 총 이닝)`;
    else if (key === 'hit') desc = `해당 ${groupText} 평균 득점률 (공타 제외 득점 비율)`;
    else if (key === 'adj') desc = `해당 ${groupText} 평균 보정 승률`;
    else if (key === 'games') desc = `해당 ${groupText} 총 경기 수`;
    else if (key === 'hr') desc = `해당 ${groupText} 최고 하이런`;
    else if (key === 'cush') desc = `해당 ${groupText} 쿠션 성공률`;
    else if (key === 'winRate') desc = `해당 ${groupText} 평균 승률`;
    else if (key === 'avgRank') desc = `해당 ${groupText} 평균 순위`;

    el.querySelector('#cdesc').textContent = desc;
    const sc = box.querySelector('.cscroll');
    if(sc && sc.scrollWidth > sc.clientWidth){
      sc.scrollLeft = sc.scrollWidth;
      box.insertAdjacentHTML('beforeend', '<div class="chint">← 옆으로 밀면 지난 경기를 볼 수 있어요</div>');
    }
  };

  el.querySelector('.pd-period').onchange = (e) => {
    playerPeriod = e.target.value;
    renderMode();
  };

  el.querySelector('.ptab').onchange = (e) => {
    playerMode = e.target.value;
    renderMode();
  };

  if (IS_ADMIN && p.id) {
    const adm = $(`<div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🛠 관리자: 선수 정보 수정</h3>
      <div class="sub" style="margin:0 0 8px">이름을 바꾸면 순위·기록에 새 이름으로 표시됩니다. 수지는 저장값 기준입니다 (예: 15 = 수지 150).</div>
      <input id="admName" class="field" maxlength="10" value="${esc(p.name)}" placeholder="이름">
      <input id="admHd" class="field" type="number" value="${p.handicap ?? ''}" placeholder="수지 저장값 (예: 15)">
      <button class="mbtn on" id="admSave">저장</button>
    </div>`);
    adm.querySelector('#admSave').onclick = async e => {
      const name = adm.querySelector('#admName').value.trim();
      const hd = parseInt(adm.querySelector('#admHd').value, 10);
      if (!name) return alert('이름을 입력하세요');
      e.target.disabled = true;
      try {
        if (!p.id) throw new Error('계정이 없는 선수(직접 입력)는 이름을 바꿀 수 없어요');
        await adminApi.renamePlayer(p.id, name, isNaN(hd) ? null : hd);   // 프로필 + 모든 경기 이름 갱신
        await reloadData();
        alert('선수 정보가 수정되었습니다.');
        showPlayer(name);
      } catch(err){ alert('수정 실패: ' + (/not_authorized|not_authenticated/.test(err.message) ? NO_PERM : err.message)); e.target.disabled = false; }
    };
    el.appendChild(adm);
  }
  document.getElementById('view').replaceChildren(el);
  renderMode();

  chartRO = new ResizeObserver(es=>{ 
    const w = es[0].contentRect.width; 
    if(Math.abs(w - lastW) > 2) {
      if (playerPeriod === '오늘') return;
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const monthStr = now.getFullYear() + '-' + pad(now.getMonth()+1);

      let hPeriod = [...p.history];
      if (playerPeriod === '이번달') {
        hPeriod = hPeriod.filter(r => r.date.startsWith(monthStr));
      }
      const h = playerMode === '통합' ? hPeriod : hPeriod.filter(r => r.type === playerMode);
      draw(chartCur, h); 
    }
  });
  chartRO.observe(el.querySelector('#cbox'));
  scrollTo(0,0);
}

function renderMe() {
  const auth = getAuth();
  const d = document.createElement('div');
  if (!auth) {
    d.innerHTML = `<div style="padding:16px 0 8px; text-align:center;">
      <p style="margin:0 0 24px 0; color:var(--text); opacity:0.8;">내 정보를 설정하려면 로그인이 필요합니다.</p>
      <a href="../score/" class="bigbtn" style="display:inline-block; text-decoration:none; box-sizing:border-box;">점수판으로 가서 로그인</a>
    </div>`;
    return d;
  }
  d.innerHTML = `<div>
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; opacity:0.8;">이름</label>
    <input type="text" id="meName" class="field" placeholder="당신의 이름">
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; opacity:0.8;">수지 (목표 점수)</label>
    <select id="meHandicap" class="field">
      <option value="">선택하세요</option>
      ${[50, 80, 100, 120, 150, 200, 250, 300, 400, 500].map(v => `<option value="${v/10}">${v}</option>`).join('')}
    </select>
    <label style="display:block; font-size:0.9rem; margin-bottom:6px; margin-top:12px; opacity:0.8;">비밀번호 변경 (변경할 때만 입력)</label>
    <input type="password" id="mePwd" class="field" placeholder="새 비밀번호 입력">
    <div id="meMsg" style="margin-bottom:16px; font-size:0.95rem; font-weight:bold; height:20px;"></div>
    <button id="meSave" class="bigbtn">저장하기</button>
    ${IS_ADMIN ? '<button id="meAdminBtn" class="bigbtn" style="margin-top:12px; background:var(--card); color:var(--accent); border:1px solid var(--accent);">👑 관리자 메뉴</button>' : ''}
    <button id="meLogout" class="obtn ghost" style="margin-top:12px; width:100%; border:1px solid var(--border); color:#f44336;">로그아웃</button>
  </div>`;
  const myData = (DATA && DATA.players) ? DATA.players.find(p => p.name === auth.name) : null;
  const myHandicap = myData ? myData.handicap : '';
  d.querySelector('#meName').value = auth.name || '';
  d.querySelector('#meHandicap').value = myHandicap;
  
  if (d.querySelector('#meAdminBtn')) {
    d.querySelector('#meAdminBtn').onclick = () => { closeMeModal(); renderAdminMenu(); };
  }

  fetch(SB_URL + '/rest/v1/profiles?id=eq.' + auth.uid, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + auth.token }
  })
  .then(r=>r.json())
  .then(rows => { if(rows && rows.length > 0) { if (rows[0].display_name) d.querySelector('#meName').value = rows[0].display_name; if (rows[0].handicap) d.querySelector('#meHandicap').value = rows[0].handicap; } }).catch(()=>{});
  d.querySelector('#meSave').onclick = async () => {
    const btn = d.querySelector('#meSave'), msg = d.querySelector('#meMsg'), name = d.querySelector('#meName').value.trim(), hd = d.querySelector('#meHandicap').value.trim(), pwd = d.querySelector('#mePwd').value;
    btn.disabled = true; msg.textContent = '저장 중...'; msg.style.color = 'var(--text)';
    try {
      if (!name) { msg.textContent = '이름을 입력하세요.'; msg.style.color = '#f44336'; btn.disabled = false; return; }
      // 이름·수지 변경 + 내가 뛴 모든 경기의 저장 이름을 서버에서 한 번에 갱신
      await adminApi.renamePlayer(auth.uid, name, hd ? parseInt(hd,10) : null);
      auth.name = name; localStorage.setItem(LS_AUTH, JSON.stringify(auth));
      if(pwd) {
        const authRes = await fetch(SB_URL + '/auth/v1/user', {
          method: 'PUT',
          headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        if(!authRes.ok) throw 0;
      }
      msg.textContent = '✅ 성공적으로 저장되었습니다.'; msg.style.color = '#4CAF50'; d.querySelector('#mePwd').value = '';
      try { await reloadData(); } catch(e){}   // 바뀐 이름을 순위·경기 화면에 즉시 반영
    } catch(e) { msg.textContent = '❌ 저장 실패. 다시 로그인해 보세요.'; msg.style.color = '#f44336'; }
    btn.disabled = false;
  };
  
  d.querySelector('#meLogout').onclick = () => {
    localStorage.removeItem(LS_AUTH);
    location.href = '../score/';
  };
  return d;
}

// ══ 내 정보 설정 모달 (팀 설정처럼 앞에 띄우는 팝업) ══
function openMeModal(){
  const m = document.getElementById('meModal'); if (!m) return;
  const body = document.getElementById('meModalBody');
  if (body) body.replaceChildren(renderMe());
  m.style.display = 'flex';
}
function closeMeModal(){ const m = document.getElementById('meModal'); if (m) m.style.display = 'none'; }

// ══ 관리자 메뉴 (전체 회원 및 소속 팀 관리) ══
async function renderAdminMenu(){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  const el = $(`<div>
    <button class="back">← 내 정보로</button>
    <div class="card">
      <h2 style="margin:0 0 16px 0; font-size:1.3rem;">👑 관리자 메뉴 (회원 및 소속팀)</h2>
      <div id="adminRosterMsg" style="color:var(--muted); font-size:0.9rem;">불러오는 중...</div>
      <div id="adminRosterList" style="display:flex; flex-direction:column; gap:12px; margin-top:12px;"></div>
    </div>
  </div>`);

  el.querySelector('.back').onclick = () => { show('rank'); openMeModal(); };

  const container = el.querySelector('#adminRosterList');
  const msg = el.querySelector('#adminRosterMsg');

  try {
    let membersWithTeams = [];
    try {
      membersWithTeams = await sbFetch('/rest/v1/rpc/admin_get_all_members', { method: 'POST', body: JSON.stringify({}) });
    } catch(rpcErr) {
      const profs = await sbFetch('/rest/v1/profiles?select=id,display_name,handicap,team_members(team_id,is_admin,teams(id,name,join_code))&order=display_name');
      membersWithTeams = (profs || []).map(p => ({
        user_id: p.id,
        display_name: p.display_name,
        handicap: p.handicap,
        teams: (p.team_members || []).map(tm => ({
          id: tm.teams ? tm.teams.id : tm.team_id,
          name: tm.teams ? tm.teams.name : '알 수 없는 팀',
          join_code: tm.teams ? tm.teams.join_code : '',
          is_admin: tm.is_admin
        }))
      }));
    }

    msg.textContent = `총 ${membersWithTeams.length}명의 회원`;

    container.innerHTML = membersWithTeams.map(m => {
      const name = m.display_name || '이름 없음';
      const teams = Array.isArray(m.teams) ? m.teams : [];
      
      const teamChips = teams.length === 0
        ? `<span style="font-size:0.85rem; color:var(--muted);">(소속 팀 없음)</span>`
        : teams.map(t => `<button class="adm-team-chip" data-tid="${esc(t.id)}" data-tname="${esc(t.name)}" data-tcode="${esc(t.join_code||'')}" style="padding:4px 10px; border-radius:6px; background:var(--card2); color:var(--accent); border:1px solid var(--line); font-size:0.85rem; font-weight:600; cursor:pointer; margin-right:6px; margin-top:4px;">${esc(t.name)}${t.is_admin ? ' 👑' : ''}</button>`).join('');

      return `<div style="padding:12px; border-radius:10px; background:var(--bg); border:1px solid var(--line); display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <a class="adm-pl-name" data-name="${esc(name)}" style="font-weight:700; font-size:1.05rem; color:var(--text); text-decoration:underline; cursor:pointer;">👤 ${esc(name)}</a>
          <span style="font-size:0.8rem; color:var(--muted);">수지 ${m.handicap ? m.handicap*10 : '—'}</span>
        </div>
        <div style="font-size:0.85rem; display:flex; flex-wrap:wrap; align-items:center; gap:4px;">
          <span style="color:var(--muted); font-size:0.8rem; margin-right:4px;">소속팀:</span>
          ${teamChips}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.adm-pl-name').forEach((a, i) => {
      a.onclick = (e) => {
        e.preventDefault();
        renderAdminMemberEditPage(membersWithTeams[i]);
      };
    });

    container.querySelectorAll('.adm-team-chip').forEach(btn => {
      btn.onclick = () => {
        openAdminTeamEditModal({ id: btn.dataset.tid, name: btn.dataset.tname, join_code: btn.dataset.tcode });
      };
    });

  } catch(e) {
    msg.textContent = '회원 목록을 불러오는 데 실패했습니다.';
  }

  document.getElementById('view').replaceChildren(el);
  scrollTo(0,0);
}

function openAdminTeamEditModal(team){
  const el = $(`<div class="ovl on" style="z-index:999;">
    <div class="ovlcard" style="max-width:400px; text-align:left;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <h3 style="margin:0; font-size:1.15rem;">🏢 팀 정보 관리</h3>
        <button class="close-btn" style="background:none; border:none; color:var(--muted); font-size:1.4rem; line-height:1; cursor:pointer; padding:0 4px;">&times;</button>
      </div>

      <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:4px;">팀 이름</label>
      <div style="display:flex; gap:8px; margin-bottom:12px;">
        <input id="admTName" value="${esc(team.name)}" maxlength="20" style="flex:1; padding:8px 10px; border-radius:8px; background:var(--bg); color:var(--text); border:1px solid var(--line); font-size:0.9rem;">
        <button id="admTRenameBtn" style="padding:8px 12px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--line); font-weight:600; font-size:0.85rem; cursor:pointer;">이름 변경</button>
      </div>

      <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:4px;">초대 코드</label>
      <div style="display:flex; gap:8px; margin-bottom:16px;">
        <input id="admTCode" value="${esc(team.join_code||'')}" maxlength="16" style="flex:1; padding:8px 10px; border-radius:8px; background:var(--bg); color:var(--text); border:1px solid var(--line); font-size:0.9rem;">
        <button id="admTCodeBtn" style="padding:8px 12px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--line); font-weight:600; font-size:0.85rem; cursor:pointer;">코드 변경</button>
      </div>

      <div id="admTMsg" style="font-size:0.85rem; min-height:1.2em; margin-bottom:16px; font-weight:600;"></div>

      <div style="padding-top:12px; border-top:1px solid var(--line); display:flex; justify-content:space-between; align-items:center;">
        <button id="admTDelBtn" style="padding:9px 14px; border-radius:8px; background:var(--card); color:var(--danger,#e5484d); border:1px solid var(--line); font-size:0.85rem; font-weight:700; cursor:pointer;">🗑️ 팀 삭제</button>
        <button class="close-btn" style="padding:9px 16px; border-radius:8px; background:var(--card); color:var(--text); border:1px solid var(--line); font-size:0.85rem; cursor:pointer;">닫기</button>
      </div>
    </div>
  </div>`);

  document.body.appendChild(el);

  const close = () => { el.remove(); };
  el.querySelectorAll('.close-btn').forEach(b => b.onclick = close);

  el.querySelector('#admTRenameBtn').onclick = async () => {
    const msg = el.querySelector('#admTMsg');
    const newName = (el.querySelector('#admTName').value || '').trim();
    if (!newName) { msg.textContent = '팀 이름을 입력하세요.'; msg.style.color = '#f44336'; return; }
    msg.textContent = '변경 중...'; msg.style.color = 'var(--text)';
    try {
      await sbFetch('/rest/v1/rpc/rename_team', { method: 'POST', body: JSON.stringify({ p_team_id: team.id, new_name: newName }) });
      msg.textContent = '✅ 팀 이름이 변경되었습니다.'; msg.style.color = '#4CAF50';
      team.name = newName;
      await loadTeams();
    } catch(e) {
      msg.textContent = /name_taken|duplicate|unique/i.test(e.message) ? '이미 사용 중인 팀 이름입니다.' : '팀 이름 변경 실패.';
      msg.style.color = '#f44336';
    }
  };

  el.querySelector('#admTCodeBtn').onclick = async () => {
    const msg = el.querySelector('#admTMsg');
    const newCode = (el.querySelector('#admTCode').value || '').trim().toUpperCase();
    if (!newCode) { msg.textContent = '초대 코드를 입력하세요.'; msg.style.color = '#f44336'; return; }
    msg.textContent = '변경 중...'; msg.style.color = 'var(--text)';
    try {
      const saved = await sbFetch('/rest/v1/rpc/set_join_code', { method: 'POST', body: JSON.stringify({ p_team_id: team.id, new_code: newCode }) });
      msg.textContent = '✅ 초대 코드가 변경되었습니다.'; msg.style.color = '#4CAF50';
      team.join_code = saved;
      el.querySelector('#admTCode').value = saved;
    } catch(e) {
      msg.textContent = /code_taken|duplicate|unique/i.test(e.message) ? '이미 사용 중인 참여 코드입니다.' : '코드 변경 실패.';
      msg.style.color = '#f44336';
    }
  };

  el.querySelector('#admTDelBtn').onclick = async () => {
    if (!confirm(`"${team.name}" 팀을 삭제하시겠습니까?\n\n- 팀 내 멤버 소속만 해제되며 회원 계정과 경기 기록은 삭제되지 않습니다.`)) return;
    const msg = el.querySelector('#admTMsg');
    msg.textContent = '팀 삭제 중...'; msg.style.color = 'var(--text)';
    try {
      try {
        await sbFetch('/rest/v1/rpc/delete_team', { method: 'POST', body: JSON.stringify({ p_team_id: team.id }) });
      } catch(rpcErr) {
        await sbFetch('/rest/v1/teams?id=eq.' + team.id, { method: 'DELETE' });
      }
      alert(`"${team.name}" 팀이 삭제되었습니다.`);
      close();
      await loadTeams();
      renderAdminMenu();
    } catch(e) {
      msg.textContent = '팀 삭제에 실패했습니다.'; msg.style.color = '#f44336';
    }
  };
}

function renderGames(){
  const periods = ['오늘', '이번달', '통산'];
  const periodSel = `<select class="field pg-period" style="width:110px; padding:6px; font-size:0.95rem; border-radius:8px; margin:0;">` + 
    periods.map(p => `<option value="${p}" ${p===rankPeriod?'selected':''}>${p}</option>`).join('') + 
    `</select>`;

  const modeSel = `<select class="field pg-mode" style="width:110px; padding:6px; font-size:0.95rem; border-radius:8px; margin:0;">` + 
    MODE_TABS.map(m => `<option value="${m}" ${m===gamesMode?'selected':''}>${m}</option>`).join('') + 
    `</select>`;

  const filteredGames = gamesMode === '통합' 
    ? DATA.games 
    : DATA.games.filter(g => g.type === gamesMode);

  const rows = [...filteredGames].sort((a,b)=>b.datetime.localeCompare(a.datetime)).map(g=>{
    const win = g.players.filter(p=>p.ranking===1).map(p=>p.name).join(', ');
    const all = g.players.map(p=>p.name).join(', ');
    return `<tr onclick="showGame('${g.id}')" style="cursor:pointer">
      <td class="name">${esc(g.date)}</td><td class="name">${esc(g.name||g.type)}</td>
      <td class="name">${esc(all)}</td><td class="name win">🏆 ${esc(win)}</td></tr>`;
  }).join('');
  
  const inner = rows ? `<table>
    <thead><tr><th class="name">날짜</th><th class="name">경기</th>
      <th class="name">참가자</th><th class="name">우승</th></tr></thead>
    <tbody>${rows}</tbody></table>` : `<div class="empty">기록이 없습니다</div>`;

  const el = $(`<div class="card">
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      ${periodSel}
      ${modeSel}
    </div>
    <div class="scroll">${inner}</div>
    <div class="sub" style="margin:10px 0 0">경기를 누르면 상세 기록을 볼 수 있습니다.</div>
  </div>`);

  el.querySelector('.pg-period').onchange = (e) => {
    rankPeriod = e.target.value;
    DATA = getFilteredData(rankPeriod);
    const sub = document.getElementById('sub');
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
    show('games');
  };

  el.querySelector('.pg-mode').onchange = (e) => {
    gamesMode = e.target.value;
    show('games');
  };

  return el;
}

function showGame(id){
  const g = DATA.games.find(v=>v.id===id);
  if(!g) return;
  // 표준 경쟁 순위: 앞선 인원 + 1 (공동 1등이 2명이면 다음은 3등). 동순위면 "공동 N등"
  const rankLabel = p => {
    const less = g.players.filter(x => x.rank < p.rank).length;
    const same = g.players.filter(x => x.rank === p.rank).length;
    return (same > 1 ? '공동 ' : '') + (less + 1) + '등';
  };
  const pRows = [...g.players].sort((a,b)=>a.rank-b.rank).map(p => {
    const avg = p.innings ? (p.score / p.innings).toFixed(3) : '0.000';
    const medal = p.rank===1 ? ' 🏆' : '';
    const shots = Math.max(1, p.score + (p.innings||0));
    const itv = p.timeMs > 0 ? (p.timeMs / shots / 1000).toFixed(1) + '초' : '—';
    return `<tr>
      <td class="name"><a class="pl" data-p="${esc(p.name)}">${esc(p.name)}</a>${medal}</td>
      <td>${rankLabel(p)}</td>
      <td><b>${p.score}</b> <span class="ar">/ ${p.target||''}</span></td>
      <td>${p.innings}</td>
      <td>${avg}</td>
      <td>${itv}</td>
      <td>${p.cushInn ? `${p.cushMade}/${p.cushInn}` : '—'}</td>
      <td>${p.highRun}</td>
      <td>${p.misses}</td>
    </tr>`;
  }).join('');
  // 게임 총 시간 = 선수별 소모 시간 합 (시간 기록이 있는 경기만)
  const totMs = g.players.reduce((a,p)=>a+(p.timeMs||0), 0);
  const totStr = totMs > 0 ? ` · 총 ${Math.floor(totMs/60000)}분 ${Math.round(totMs%60000/1000)}초` : '';
  const el = $(`<div>
    <button class="back">← 경기 목록으로</button>
    <div class="card">
      <h2 style="margin:0 0 4px">🎱 ${esc(g.name||g.type)}</h2>
      <div class="sub" style="margin:0 0 16px">${esc(g.datetime)}${totStr}</div>
      <div class="scroll">
        <table class="statgrid">
          <thead><tr><th class="name">선수</th><th>순위</th><th>점수</th><th>이닝</th><th>에버</th><th>인터벌</th><th>쿠션</th><th>하이런</th><th>공타</th></tr></thead>
          <tbody>${pRows}</tbody>
        </table>
      </div>
    </div>
  </div>`);
  el.querySelector('.back').onclick=()=>show('games');
  el.querySelectorAll('a.pl').forEach(a=>a.onclick=()=>showPlayer(a.dataset.p));
  if (IS_ADMIN) attachGameAdmin(el, id);
  document.getElementById('view').replaceChildren(el);
  scrollTo(0,0);
}
window.showGame = showGame;   // 모듈 전환 후에도 인라인 onclick에서 접근 가능하도록

/* 오프라인 대기열 동기화는 점수판(score/)이 담당한다.
 * 앱 시작 화면이 점수판이라 기록실엔 반드시 점수판을 거쳐 오므로 여기선 불필요. */
async function initDashboard() {
  const sub = document.getElementById('sub');
  if (sub) sub.textContent = '서버에서 데이터를 불러오는 중입니다...';
  try {
    await loadTeams();   // 현재 팀 확정 후 그 팀 게임만 로드
    const [games, members, adm] = await Promise.all([
      fetchGames(),
      fetchMembers().catch(() => []),
      fetchAdmin()
    ]);
    RAW_GAMES = games;
    RAW_MEMBERS = members;
    IS_ADMIN = adm;
    DATA = getFilteredData(rankPeriod);
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
    const t = new URLSearchParams(location.search).get('tab') || 'rank';
    if (t === 'me') { show('rank'); openMeModal(); }   // 점수판에서 넘어온 내 정보 딥링크 → 팝업
    else show(t);
  } catch(e) { if (sub) sub.textContent = '데이터를 불러오는데 실패했습니다.'; }
}

let chartRO = null;
function show(v){
  if(v==='me'){ openMeModal(); return; }   // 내 정보는 팝업 모달로 (기본 화면 유지)
  if(chartRO){ chartRO.disconnect(); chartRO = null; }
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.dataset.v===v));
  
  const auth = getAuth();
  const uName = document.getElementById('topUserName');
  if (uName) uName.textContent = auth ? auth.name : '게스트';
  const ico = document.getElementById('topUserIcon');
  if (ico) ico.textContent = (auth && IS_ADMIN) ? '🛡️' : '👤';
  const myRecBtn = document.getElementById('btnMyRec');
  if(myRecBtn){
    if(auth && auth.name && DATA && DATA.players && DATA.players.find(p=>p.name===auth.name)) {
      myRecBtn.style.display = 'block';
      myRecBtn.onclick = () => showPlayer(auth.name);
    } else {
      myRecBtn.style.display = 'none';
    }
  }
  
  let node;
  if(v==='rank') node = renderRank();
  else if(v==='games') node = renderGames();
  document.getElementById('view').replaceChildren(node);
}
document.querySelectorAll('.tab').forEach(t=>{ if(t.id!=='btnSettings') t.onclick=()=>show(t.dataset.v); });

// ══ 설정 모달 (팀 설정 / 내 정보 설정 / 음향 / 테마) ══ — 테마 헬퍼는 common.js 에서 import
const LS_VOICE = 'dangScoreVoice';
const getVoice = () => { try { const v = localStorage.getItem(LS_VOICE); return v == null ? true : JSON.parse(v); } catch(e){ return true; } };
const setVoice = b => { try { localStorage.setItem(LS_VOICE, JSON.stringify(b)); } catch(e){} };
(function initSettings(){
  const modal = document.getElementById('setModal'); if (!modal) return;
  const vbtn = document.getElementById('setVoice');
  const themeBtns = modal.querySelectorAll('#setTheme button');
  const sync = () => {
    vbtn.classList.toggle('on', getVoice());
    const cur = getTheme();
    themeBtns.forEach(b => b.classList.toggle('on', b.dataset.t === cur));
  };
  const open = () => { sync(); modal.classList.add('on'); };
  const close = () => modal.classList.remove('on');
  document.getElementById('btnSettings').onclick = open;
  document.getElementById('setClose').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  document.getElementById('setTeam').onclick = () => { close(); if (getAuth()) openTeamModal(); else openMeModal(); };
  document.getElementById('setMe').onclick = () => { close(); openMeModal(); };
  vbtn.onclick = () => { const nv = !getVoice(); setVoice(nv); vbtn.classList.toggle('on', nv); };
  themeBtns.forEach(b => b.onclick = () => {
    const t = b.dataset.t;
    try { if (t === 'system') localStorage.removeItem(LS_THEME); else localStorage.setItem(LS_THEME, t); } catch(e){}
    applyTheme(t); sync();
  });
  applyTheme(getTheme());
})();

// 내 정보 설정 모달 닫기 (× 버튼 / 배경 클릭)
(function initMeModal(){
  const m = document.getElementById('meModal'); if (!m) return;
  const x = document.getElementById('meClose');
  if (x) x.onclick = closeMeModal;
  m.onclick = e => { if (e.target === m) closeMeModal(); };
})();

initDashboard();

// ══ 서비스 워커 등록 + 자동 업데이트 ══ (공통 모듈)
registerSW();


// ══ 관리자 메뉴: 회원 정보 수정 전용 화면 ══
function renderAdminMemberEditPage(m){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  const el = $(`<div>
    <button class="back">← 관리자 메뉴로</button>
    <div class="card">
      <h2 style="margin:0 0 16px 0; font-size:1.3rem;">👤 "${esc(m.display_name||'이름 없음')}" 회원 정보 수정</h2>

      <div style="margin-bottom:16px;">
        <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:6px;">이름 (닉네임)</label>
        <input id="admMName" value="${esc(m.display_name||'')}" maxlength="10" class="field" style="margin:0;">
      </div>

      <div style="margin-bottom:16px;">
        <label style="display:block; font-size:0.85rem; color:var(--muted); margin-bottom:6px;">수지 (점수)</label>
        <select id="admMHd" class="field" style="margin:0;">
          <option value="">수지 선택</option>
          ${[50, 80, 100, 120, 150, 200, 250, 300, 400, 500].map(v => `<option value="${v/10}" ${m.handicap === v/10 ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>

      <div id="admMMsg" style="font-size:0.85rem; min-height:1.2em; margin-bottom:16px; font-weight:600;"></div>

      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <button id="admMBackBtn" class="obtn ghost" style="width:auto; padding:10px 18px; cursor:pointer;">← 목록으로</button>
        <button id="admMSaveBtn" class="bigbtn" style="width:auto; padding:10px 24px;">수정사항 저장</button>
      </div>
    </div>
  </div>`);

  el.querySelector('.back').onclick = () => renderAdminMenu();
  el.querySelector('#admMBackBtn').onclick = () => renderAdminMenu();

  el.querySelector('#admMSaveBtn').onclick = async () => {
    const msg = el.querySelector('#admMMsg');
    const newName = (el.querySelector('#admMName').value || '').trim();
    const hdVal = el.querySelector('#admMHd').value;
    const newHd = hdVal ? parseInt(hdVal, 10) : null;

    if (!newName) { msg.textContent = '이름을 입력하세요.'; msg.style.color = '#f44336'; return; }
    msg.textContent = '저장 중...'; msg.style.color = 'var(--text)';
    try {
      await adminApi.renamePlayer(m.user_id, newName, newHd);
      msg.textContent = '✅ 회원 정보가 성공적으로 수정되었습니다.'; msg.style.color = '#4CAF50';
      m.display_name = newName;
      m.handicap = newHd;
      await reloadData();
    } catch(err) {
      msg.textContent = '수정 실패: ' + (/not_authorized|not_authenticated/.test(err.message) ? NO_PERM : err.message);
      msg.style.color = '#f44336';
    }
  };

  document.getElementById('view').replaceChildren(el);
  scrollTo(0,0);
}
