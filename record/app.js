let DATA = { updated: '', players: [], games: [] };

const SB_URL = 'https://ezwassqurbmzcjfmtjop.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6d2Fzc3F1cmJtemNqZm10am9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjMxOTIsImV4cCI6MjA5OTc5OTE5Mn0.O6eHOO4-yxW7HVmNVjOkakrcoEeF5tORylhG1j79BeU';
const LS_AUTH = 'dangScoreAuth';

async function fetchGames() {
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  try {
    const auth = getAuth();
    if (auth && auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
  } catch(e) {}
  
  const res = await fetch(SB_URL + '/rest/v1/games?select=id,played_at,players&order=played_at.asc', {
    headers: headers
  });
  if (!res.ok) throw new Error('fetch error');
  return await res.json();
}

async function fetchMembers() {
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json' };
  try {
    const auth = getAuth();
    if (auth && auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
  } catch(e) {}
  
  const res = await fetch(SB_URL + '/rest/v1/profiles?select=id,display_name,handicap&order=display_name', {
    headers: headers
  });
  if (!res.ok) throw new Error('fetch error');
  return await res.json();
}

function processData(games, members) {
  const pmap = {};
  const dataGames = [];

  for (const g of games) {
    const dt = new Date(g.played_at);
    const pad = n => String(n).padStart(2, '0');
    const dateStr = dt.getFullYear() + '-' + pad(dt.getMonth()+1) + '-' + pad(dt.getDate());
    const datetimeStr = dateStr + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
    const isTeam = g.players && g.players.length > 0 && g.players[0].isTeam;
    const typeStr = isTeam ? '팀전' : (g.players.length + '인');
    const nameStr = typeStr;

    dataGames.unshift({
      id: String(g.id || datetimeStr),
      date: dateStr,
      datetime: datetimeStr,
      type: typeStr,
      name: nameStr,
      players: g.players.map(p => ({
        name: p.name || p.id || "알 수 없음", ranking: p.win ? 1 : 2,
        rank: p.rank != null ? p.rank : (p.win ? 1 : 2),
        timeMs: p.timeMs ?? p.time_ms ?? 0,
        target: p.target, score: p.score, innings: p.innings,
        highRun: p.highRun ?? p.high_run ?? 0, misses: p.misses ?? 0, cushMade: p.cushMade ?? p.cush_made ?? 0, cushInn: p.cushInn ?? p.cush_inn ?? 0
      }))
    });

    // 게임 내 각 선수의 평균순위(분수). 동순위는 공동 점유 구간의 평균: 공동 2등 = 2.5, 공동 3등 = 3.5
    const ranks = g.players.map(pp => (pp.rank != null ? pp.rank : (pp.win ? 1 : 2)));
    const fracRank = idx => {
      const r = ranks[idx]; let less = 0, eq = 0;
      for (const rr of ranks) { if (rr < r) less++; else if (rr === r) eq++; }
      return less + (eq + 1) / 2;
    };

    for (const p of g.players) {
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
        if (m.display_name) p.name = m.display_name;   // 이름 변경 시 최신 이름으로
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
  if(mode==='통합') return DATA.players.filter(p=>p.games>0);
  return DATA.players
    .filter(p=>p.modes[mode] && p.modes[mode].games>0)
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
  
  // Re-sort correctly since adjRate is primary fallback for some sortKeys if needed, but above handles the requested keys.
  const subtabs = MODE_TABS.map(m=>
    `<button class="tab ${m===rankMode?'on':''}" data-m="${m}" style="flex:1;padding:8px 4px;text-align:center">${m}</button>`).join('');
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
      <div class="tabs" style="margin-bottom:14px; flex-wrap:nowrap">${subtabs}</div>
      ${inner}
      <div class="sub" style="margin:10px 0 0">${note}</div></div>`);
  el.querySelectorAll('.tab[data-m]').forEach(t=>t.onclick=()=>{
    rankMode = t.dataset.m; sortKey = defSort(rankMode); sortAsc=false; show('rank');
  });
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
  const max = opt.max || (Math.max(...vals)*1.15 || 1);
  const x = i => P.l + (vals.length===1?iw/2:iw*i/(vals.length-1));
  const y = v => P.t + ih - (v/max)*ih;

  const gap = iw/(vals.length-1);
  const showVal = gap >= 36;
  const xStep = Math.max(1, Math.ceil(34/gap));

  let g='';
  for(let i=0;i<=4;i++){
    const yy=P.t+ih*i/4, v=(max*(4-i)/4);
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
  {k:'avg', t:'에버리지', desc:'최근 경기부터의 누적/개별 에버리지', vals:h=>h.map(r=>r.average), dec:2},
  {k:'hit', t:'득점률',   desc:'최근 경기부터의 득점률', vals:h=>h.map(r=>r.inning ? (r.inning-r.miss)/r.inning*100 : 0), max:100, suffix:'%', dec:0},
  {k:'adj', t:'보정 승률', desc:'그 경기까지의 누적 보정 승률', vals:h=>{let p=0; return h.map((r,i)=>{ p+=(r.adjPt||0); return p/(i+1); });}, max:100, suffix:'%', dec:1},
];

function showPlayer(name){
  const p = DATA.players.find(v=>v.name===name);
  const h = [...p.history];
  const el = $(`<div>
    <button class="back">← 순위로</button>
    <div class="card">
      <h2 style="margin:0">${esc(p.name)}</h2>
      <div class="sub" style="margin:2px 0 0">수지 ${p.handicap * 10}</div>
      <div class="stats">
        <div class="st"><div class="k">경기</div><div class="v">${p.games}</div></div>
        <div class="st"><div class="k">승 / 패</div><div class="v">${p.wins} / ${p.games-p.wins}</div></div>
        <div class="st"><div class="k">보정 승률</div><div class="v">${p.adjRate==null?'—':p.adjRate.toFixed(1)+'%'}</div></div>
        <div class="st"><div class="k">에버리지</div><div class="v">${p.avgAvg.toFixed(3)}</div></div>
        <div class="st"><div class="k">쿠션 성공률</div><div class="v">${p.cushRate==null?'—':p.cushRate.toFixed(1)+'%'}</div></div>
        <div class="st"><div class="k">득점률</div><div class="v">${p.hitRate.toFixed(1)}%</div></div>
        <div class="st"><div class="k">하이런</div><div class="v">${p.bestHr}</div></div>
      </div>
      <div class="chead">
        <h3 style="font-size:1rem;margin:0">📈 추이</h3>
        <div class="mbtns">${METRICS.map((m,i)=>
          `<button class="mbtn${i===0?' on':''}" data-m="${m.k}">${m.t}</button>`).join('')}</div>
      </div>
      <div class="sub" id="cdesc" style="margin:0 0 6px"></div>
      <div id="cbox"></div>
    </div>
    <div class="card"><h3 style="font-size:1rem;margin:0 0 10px">🗒️ 경기 이력</h3>
      <div class="scroll"><table>
        <thead><tr><th class="name">날짜</th><th class="name">상대</th><th>점수</th>
          <th>이닝</th><th>에버</th><th>하이런</th><th>결과</th></tr></thead>
        <tbody>${[...h].reverse().map(r=>`<tr>
          <td class="name">${esc(r.date)}</td><td class="name">${esc(r.opponents)}</td>
          <td>${r.score}</td><td>${r.inning}</td><td>${+r.average.toFixed(3)}</td>
          <td>${r.highRun}</td><td>${r.win?'<span class="win">🏆</span>':'—'}</td></tr>`).join('')}
        </tbody></table></div></div>
  </div>`);
  el.querySelector('.back').onclick=()=>show('rank');
  const labels = h.map(r=>r.date.slice(5));
  let cur = 'avg', lastW = 0;
  const draw = (key) => {
    cur = key;
    const m = METRICS.find(v=>v.k===key);
    const box = el.querySelector('#cbox');
    lastW = box.clientWidth || innerWidth-64;
    box.innerHTML = chart(m.vals(h), labels, {...m, W: lastW});
    el.querySelector('#cdesc').textContent = m.desc;
    el.querySelectorAll('.mbtn').forEach(b=>b.classList.toggle('on', b.dataset.m===key));
    const sc = box.querySelector('.cscroll');
    if(sc && sc.scrollWidth > sc.clientWidth){
      sc.scrollLeft = sc.scrollWidth;
      box.insertAdjacentHTML('beforeend', '<div class="chint">← 옆으로 밀면 지난 경기를 볼 수 있어요</div>');
    }
  };
  el.querySelectorAll('.mbtn').forEach(b=>b.onclick=()=>draw(b.dataset.m));
  document.getElementById('view').replaceChildren(el);
  draw('avg');
  chartRO = new ResizeObserver(es=>{ const w = es[0].contentRect.width; if(Math.abs(w - lastW) > 2) draw(cur); });
  chartRO.observe(el.querySelector('#cbox'));
  scrollTo(0,0);
}

function renderMe() {
  const auth = getAuth();
  const d = document.createElement('div');
  if (!auth) {
    d.innerHTML = `<div class="card" style="padding:40px 20px; text-align:center;">
      <h2 style="margin:0 0 16px 0;">👤 내 정보</h2>
      <p style="margin:0 0 24px 0; color:var(--text); opacity:0.8;">내 정보를 설정하려면 로그인이 필요합니다.</p>
      <a href="../score/" class="bigbtn" style="display:inline-block; text-decoration:none; box-sizing:border-box;">점수판으로 가서 로그인</a>
    </div>`;
    return d;
  }
  d.innerHTML = `<div class="card" style="padding:24px 20px;">
    <h2 style="margin:0 0 20px 0; font-size:1.3rem;">👤 내 정보 설정</h2>
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
    <button id="meLogout" class="obtn ghost" style="margin-top:12px; width:100%; border:1px solid var(--border); color:#f44336;">로그아웃</button>
  </div>`;
  const myData = DATA.players.find(p => p.name === auth.name);
  const myHandicap = myData ? myData.handicap : '';
  d.querySelector('#meName').value = auth.name || '';
  d.querySelector('#meHandicap').value = myHandicap;
  
  fetch(SB_URL + '/rest/v1/profiles?id=eq.' + auth.uid, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + auth.token }
  })
  .then(r=>r.json())
  .then(rows => { if(rows && rows.length > 0) { if (rows[0].display_name) d.querySelector('#meName').value = rows[0].display_name; if (rows[0].handicap) d.querySelector('#meHandicap').value = rows[0].handicap; } }).catch(()=>{});
  d.querySelector('#meSave').onclick = async () => {
    const btn = d.querySelector('#meSave'), msg = d.querySelector('#meMsg'), name = d.querySelector('#meName').value.trim(), hd = d.querySelector('#meHandicap').value.trim(), pwd = d.querySelector('#mePwd').value;
    btn.disabled = true; msg.textContent = '저장 중...'; msg.style.color = 'var(--text)';
    try {
      const pRes = await fetch(SB_URL + '/rest/v1/profiles?id=eq.' + auth.uid, {
        method: 'PATCH',
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name, handicap: hd ? parseInt(hd,10) : null })
      });
      if(!pRes.ok) throw 0;
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
    } catch(e) { msg.textContent = '❌ 저장 실패. 다시 로그인해 보세요.'; msg.style.color = '#f44336'; }
    btn.disabled = false;
  };
  
  d.querySelector('#meLogout').onclick = () => {
    localStorage.removeItem(LS_AUTH);
    location.href = '../score/';
  };
  return d;
}

function renderGames(){
  const rows = [...DATA.games].sort((a,b)=>b.datetime.localeCompare(a.datetime)).map(g=>{
    const win = g.players.filter(p=>p.ranking===1).map(p=>p.name).join(', ');
    const all = g.players.map(p=>p.name).join(', ');
    return `<tr onclick="showGame('${g.id}')" style="cursor:pointer">
      <td class="name">${esc(g.date)}</td><td class="name">${esc(g.name||g.type)}</td>
      <td class="name">${esc(all)}</td><td class="name win">🏆 ${esc(win)}</td></tr>`;
  }).join('');
  return $(`<div class="card"><div class="scroll"><table>
    <thead><tr><th class="name">날짜</th><th class="name">경기</th>
      <th class="name">참가자</th><th class="name">우승</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="sub" style="margin:10px 0 0">경기를 누르면 상세 기록을 볼 수 있습니다.</div></div>`);
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
  document.getElementById('view').replaceChildren(el);
  scrollTo(0,0);
}

/* 오프라인 대기열 동기화는 점수판(score/)이 담당한다.
 * 앱 시작 화면이 점수판이라 기록실엔 반드시 점수판을 거쳐 오므로 여기선 불필요. */
async function initDashboard() {
  const sub = document.getElementById('sub');
  if (sub) sub.textContent = '서버에서 데이터를 불러오는 중입니다...';
  try {
    const [games, members] = await Promise.all([
      fetchGames(),
      fetchMembers().catch(() => [])
    ]);
    DATA = processData(games, members);
    if (sub) sub.textContent = '최종 업데이트 ' + DATA.updated + ' · 총 ' + DATA.games.length + '경기 · 선수 ' + DATA.players.length + '명';
    const t = new URLSearchParams(location.search).get('tab') || 'rank';
    show(t);
  } catch(e) { if (sub) sub.textContent = '데이터를 불러오는데 실패했습니다.'; }
}

let chartRO = null;
function show(v){
  if(chartRO){ chartRO.disconnect(); chartRO = null; }
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.dataset.v===v));
  
  const auth = getAuth();
  document.getElementById('topUserName').textContent = auth ? auth.name : '게스트';
  const myRecBtn = document.getElementById('btnMyRec');
  if(myRecBtn){
    if(auth && auth.name && DATA.players.find(p=>p.name===auth.name)) {
      myRecBtn.style.display = 'block';
      myRecBtn.onclick = () => showPlayer(auth.name);
    } else {
      myRecBtn.style.display = 'none';
    }
  }
  
  let node;
  if(v==='rank') node = renderRank();
  else if(v==='games') node = renderGames();
  else if(v==='me') node = renderMe();
  document.getElementById('view').replaceChildren(node);
}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>show(t.dataset.v));

initDashboard();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('../sw.js').catch(()=>{});
  
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

(function checkStandalone(){
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (!isStandalone && location.protocol !== 'file:' && !location.search.includes('dev=1')) {
    window.location.replace('../');
  }
})();
