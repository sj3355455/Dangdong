import { sbFetch, sbAuth } from '../record/supabase.js';

const $ = s => document.querySelector(s);
const show = id => document.querySelectorAll('.screen').forEach(el => el.style.display = el.id === id ? 'flex' : 'none');
const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };
// Removed Javascript Fullscreen API to avoid browser security overlay

const LS_AUTH = 'dangScoreAuth', LS_PREFS = 'dangScorePrefs_v4', LS_MEM = 'dangScoreMem', LS_STATE = 'dangScoreState', LS_QUEUE = 'dangScoreQueue';
const MANUAL = '__MANUAL__';

let auth = lsGet(LS_AUTH, null);
let members = lsGet(LS_MEM, []);
let prefs = lsGet(LS_PREFS, { gameType:'2인', names:['','','',''], pids:[null,null,null,null], targets:[15,15,15,15], myBall:0, cushGoal:1 });
if (prefs.cushGoal == null) prefs.cushGoal = 1;
let S = lsGet(LS_STATE, null);

const ZCOLORS = ['w','y','w','y'];
const ZNAMES = ['⚪ 흰 공', '🟡 노란 공', '⚪ 흰 공', '🟡 노란 공'];
const TZNAMES = ['우리 팀', '상대 팀'];

const api = {
  members: () => sbFetch('/rest/v1/profiles?select=id,display_name,handicap&order=display_name'),
  myProfile: uid => sbFetch('/rest/v1/profiles?select=display_name&id=eq.' + uid),
  createProfile: (uid, name) => sbFetch('/rest/v1/profiles', { method: 'POST', body: JSON.stringify({ id: uid, display_name: name }) }),
  submitGame: payload => sbFetch('/rest/v1/games', { method: 'POST', body: JSON.stringify(payload) })
};

// ══ Auth ══
let authMode = 'login';
function setMode(m){
  authMode = m;
  $('#tabLogin').className = m==='login'?'on':'';
  $('#tabSignup').className = m==='signup'?'on':'';
  $('#btnAuth').textContent = m==='login'?'로그인':'회원가입';
  $('#aName').style.display = m==='signup' ? '' : 'none';   // 이름은 회원가입 때만 입력
  $('#aPass').autocomplete = m==='signup' ? 'new-password' : 'current-password';
  $('#aErr').textContent = '';
}
$('#tabLogin').onclick = () => setMode('login');
$('#tabSignup').onclick = () => setMode('signup');

$('#btnAuth').onclick = async () => {
  const btn = $('#btnAuth'), err = $('#aErr');
  const loginId = $('#aId').value.trim();
  const name = $('#aName').value.trim(), pass = $('#aPass').value;
  const isSignup = authMode === 'signup';
  if (!loginId || pass.length < 6) return err.textContent = '아이디와 6자 이상 비밀번호를 입력하세요';
  if (isSignup && !name) return err.textContent = '기록에 표시할 이름을 입력하세요';
  err.textContent = ''; btn.disabled = true;

  try {
    const a = await sbAuth(loginId, pass, isSignup);   // 로그인 열쇠는 '아이디' — 이름을 바꿔도 안 바뀜
    auth = { uid: a.uid, name: isSignup ? name : '', loginId, token: a.token, refresh: a.refresh };
    lsSet(LS_AUTH, auth);

    if (isSignup) {
      try { await api.createProfile(a.uid, name); }
      catch(e){
        auth = null; localStorage.removeItem(LS_AUTH);
        throw new Error(e.message);
      }
    } else {
      const p = await api.myProfile(a.uid);
      if (p && p[0]) { auth.name = p[0].display_name; lsSet(LS_AUTH, auth); }
    }
    await loadMembers();
    upsertMember(auth.uid, auth.name);
    queueFlush();
    show('setup');
    toast(`${auth.name}님, 환영합니다!`);
  } catch(e){
    err.textContent = translateAuthError(e.message);
  } finally {
    btn.disabled = false; setMode(authMode);
  }
};
function translateAuthError(m){
  if (/Invalid login/i.test(m)) return '아이디 또는 비밀번호가 틀렸어요';
  if (/already registered/i.test(m)) return '이미 등록된 아이디예요. 로그인해 주세요';
  if (/Password should be/i.test(m)) return '비밀번호는 6자 이상이어야 해요';
  if (/rate limit/i.test(m)) return '요청이 너무 잦아요. 잠시 후 다시 시도해 주세요';
  if (/fetch|Network/i.test(m)) return '인터넷 연결을 확인해 주세요';
  return '문제가 발생했어요. 다시 시도해 주세요';
}
$('#btnGuest').onclick = () => { show('setup'); toast('게스트 모드 — 기록은 저장되지 않아요'); };

async function loadMembers(){ try { members = await api.members(); lsSet(LS_MEM, members); }catch(e){} }
function upsertMember(id, name){
  if (!id || !name) return;
  const i = members.findIndex(m => m.id === id);
  if (i >= 0) members[i].display_name = name;
  else members.push({ id, display_name:name });
  members.sort((a, b) => a.display_name.localeCompare(b.display_name, 'ko'));
  lsSet(LS_MEM, members);
}

// ══ Setup UI ══
function renderSetupCards(modeChanged = false) {
  const isTeam = prefs.gameType === '팀전';
  const N = isTeam ? 2 : parseInt(prefs.gameType.replace('인',''), 10);
  const totalPlayers = isTeam ? 4 : N;
  
  let html = '';
  if (isTeam) {
    for (let i = 0; i < 2; i++) {
      html += `
        <div class="pcard ${prefs.myBall === i ? 'me' : ''}" id="pcard${i}">
          <div class="prow"><span class="dot ${ZCOLORS[i]}"></span> <span class="plbl ${prefs.myBall === i ? 'me' : 'opp'}">${prefs.myBall === i ? '나' : '상대'}</span></div>
          <div style="font-weight:bold; margin-bottom:8px;">${TZNAMES[i]}</div>
          <div style="display:flex; gap:8px; margin-bottom:8px;">
            <select class="field" id="sel${i}" style="flex:1; margin:0; padding:10px;"></select>
            <input class="field" id="name${i}" maxlength="10" placeholder="선수 1" style="flex:1; margin:0; padding:10px;">
          </div>
          <div style="display:flex; gap:8px; margin-bottom:8px;">
            <select class="field" id="sel${i+2}" style="flex:1; margin:0; padding:10px;"></select>
            <input class="field" id="name${i+2}" maxlength="10" placeholder="선수 2" style="flex:1; margin:0; padding:10px;">
          </div>
          <div class="trow" style="justify-content:flex-start; gap:12px; align-items:center;">
            <span class="lbl">팀 목표 점수</span>
            <b class="tval" id="tval${i}" style="font-size:1.2rem; line-height:1; padding-top:2px;">${prefs.targets[i]}</b>
            <div style="flex:1;"></div>
            <button class="mbtn" onclick="openTargetPopup(${i})">변경</button>
          </div>
        </div>
      `;
    }
  } else {
    for (let i = 0; i < N; i++) {
      html += `
        <div class="pcard ${prefs.myBall === i ? 'me' : ''}" id="pcard${i}">
          <div class="prow"><span class="dot ${ZCOLORS[i]}"></span> <span class="plbl ${prefs.myBall === i ? 'me' : 'opp'}">${prefs.myBall === i ? '나' : '상대'}</span>
            <select class="field" id="sel${i}" style="margin:0; padding:8px 12px;"></select></div>
          <input class="field" id="name${i}" maxlength="10" placeholder="${ZNAMES[i]} 선수">
          <div class="trow" style="justify-content:flex-start; gap:12px; align-items:center;">
            <span class="lbl">목표 점수</span>
            <b class="tval" id="tval${i}" style="font-size:1.2rem; line-height:1; padding-top:2px;">${prefs.targets[i]}</b>
            <div style="flex:1;"></div>
            <button class="mbtn" onclick="openTargetPopup(${i})">변경</button>
          </div>
        </div>
      `;
    }
  }
  $('#setupCards').innerHTML = html;
  
  let mbHtml = '';
  for (let i = 0; i < (isTeam ? 2 : N); i++) {
    const ballIcon = i % 2 === 0 ? '⚪' : '🟡';
    const label = `${i + 1}번(${ballIcon})`;
    mbHtml += `<button id="first${i}" class="${prefs.myBall === i ? 'on' : ''}" onclick="applyMyBall(${i})">${label}</button>`;
  }
  $('#myBallSeg').innerHTML = mbHtml;
  syncCushSeg();

  for (let i = 0; i < totalPlayers; i++) {
    fillSelect(i, modeChanged);
    const sel = $('#sel'+i);
    if(sel) {
      sel.onchange = () => { applySel(i, true); $('#name'+i).value = prefs.names[i]; };
      if($('#name'+i)){
        $('#name'+i).oninput = e => { prefs.names[i] = e.target.value; lsSet(LS_PREFS, prefs); };
        $('#name'+i).value = prefs.names[i];
      }
    }
  }
  
  const showSel = !!auth && members.length > 0;
  for (let i = 0; i < totalPlayers; i++) {
    const sel = $('#sel'+i);
    if(sel) sel.style.display = showSel ? '' : 'none';
    if(!showSel && $('#name'+i)) $('#name'+i).style.display = '';
  }

  for (let i = 0; i < (isTeam ? 2 : N); i++) {
    const isMe = (prefs.myBall === i);
    if (isTeam) {
      if($('#sel'+(i*2))) $('#sel'+(i*2)).disabled = (i*2 === 0);   // 1번 시드(sel0) = 나 고정
      if($('#sel'+(i*2+1))) $('#sel'+(i*2+1)).disabled = false;
    } else {
      if($('#sel'+i)) $('#sel'+i).disabled = isMe;
      if($('#name'+i)) $('#name'+i).disabled = isMe;
    }
  }
}

function fillSelect(i, isUserAction = false){
  const sel = $('#sel'+i);
  if(!sel) return;
  const cur = prefs.pids[i];
  
  // 본인은 '상대' 슬롯 목록에선 제외하되, 본인이 배정된 '나' 슬롯에선 유지(이름 자동 채움용)
  const listMembers = members.filter(m => !auth || m.id !== auth.uid || prefs.pids[i] === auth.uid);
  
  sel.innerHTML = listMembers.map(m => `<option value="${esc(m.id)}">${esc(m.display_name)}</option>`).join('') +
    `<option value="${MANUAL}">✏️ 직접 입력</option>`;
    
  // 현재 값이 있으면 선택하고, 없으면 빈 값(아무것도 선택안됨) 유지
  // option value="" 가 없더라도 강제로 첫번째나 빈 값을 지정
  if (cur) {
    sel.value = cur;
  } else if (prefs.names[i]) {
    sel.value = MANUAL;
  } else {
    // 아무것도 선택되지 않았을 때의 처리를 위해 빈 옵션을 숨겨서 추가해둘 수도 있지만
    // select 요소의 value를 임의로 지정해둔다 (브라우저가 첫번째 옵션을 보여주긴 함)
    // 그러나 "선수 선택.."이라는 글자는 보이지 않음
  }
  
  // 첫 로드 시(isUserAction=false) sel.value가 강제로 첫번째 옵션으로 지정되었다면
  // 현재 prefs에 그 값이 없으므로(cur가 빈값) applySel에서 덮어쓰게 될 수 있음.
  // 따라서 빈 값일 땐 일단은 빈 문자열로 두는 보이지 않는 option 하나가 필요할 수 있음.
  // 사용자가 '선수선택..' 글자를 싫어하는 것이므로 빈 라벨 옵션을 추가.
  if (!cur && !prefs.names[i]) {
    sel.insertAdjacentHTML('afterbegin', '<option value="" style="display:none;"></option>');
    sel.value = '';
  }
  
  applySel(i, isUserAction);
}

function applySel(i, isUserAction){
  const sel = $('#sel'+i);
  if(!sel) return;
  const v = sel.value;
  const manual = (v === MANUAL);
  if($('#name'+i)) $('#name'+i).style.display = manual ? '' : 'none';
  if (manual) { prefs.pids[i] = null; }
  else if (v) {
    const m = members.find(x => x.id === v);
    prefs.pids[i] = v; prefs.names[i] = m ? m.display_name : '';
    if (isUserAction) {
      if (prefs.gameType === '팀전') {
        const teamIdx = i % 2;
        const p1 = prefs.pids[teamIdx];
        const p2 = prefs.pids[teamIdx + 2];
        const m1 = members.find(x => x.id === p1);
        const m2 = members.find(x => x.id === p2);
        let sum = 0, count = 0;
        if (m1 && m1.handicap != null) { sum += parseInt(m1.handicap, 10); count++; }
        if (m2 && m2.handicap != null) { sum += parseInt(m2.handicap, 10); count++; }
        if (count > 0) {
          prefs.targets[teamIdx] = Math.round(sum / count);
          if($('#tval'+teamIdx)) $('#tval'+teamIdx).textContent = prefs.targets[teamIdx];
        }
      } else if (m && m.handicap != null) {
        prefs.targets[i] = parseInt(m.handicap, 10);
        if($('#tval'+i)) $('#tval'+i).textContent = prefs.targets[i];
      }
    }
  } else { prefs.pids[i] = null; prefs.names[i] = ''; }
  lsSet(LS_PREFS, prefs);
}

document.querySelectorAll('#gameTypeSeg button').forEach(b => {
  b.onclick = () => {
    const newVal = b.dataset.v || b.innerText;
    const modeChanged = (prefs.gameType !== newVal);
    prefs.gameType = newVal;
    
    if (modeChanged) {
      prefs.myBall = 0;
      if (auth) {
        prefs.pids[0] = auth.uid;
      }
    }
    
    lsSet(LS_PREFS, prefs);
    syncSetup(modeChanged);
  };
});

function syncSetup(modeChanged = false){
  const lo = $('#btnLogout');
  if (lo) lo.onclick = () => {
    if (!confirm('처음 화면으로 돌아갈까요?')) return;
    auth = null; localStorage.removeItem(LS_AUTH); show('auth');
  };
  
  document.querySelectorAll('#gameTypeSeg button').forEach(b => {
    if ((b.dataset.v || b.innerText) === prefs.gameType) b.classList.add('on');
    else b.classList.remove('on');
  });
  
  renderSetupCards(modeChanged);

  const q = lsGet(LS_QUEUE, []).length;
  $('#saveNote').innerHTML = auth
    ? `<span class="pip"></span> 경기 종료 시 서버에 자동 저장${q ? ` · 대기 ${q}건` : ''}`
    : `<span class="pip off"></span> 게스트 모드 — 기록이 저장되지 않아요`;
}

let curTargetEdit = 0;
window.openTargetPopup = function(i) {
  curTargetEdit = i;
  // 공 색은 턴에 따라 바뀌므로 제목엔 선수 이름을 쓴다 (없으면 자리 번호)
  const who = prefs.gameType === '팀전' ? TZNAMES[i] : (prefs.names[i] || `${i + 1}번 선수`);
  $('#targetOvlTitle').textContent = who + ' 목표 점수';
  $('#tvalEdit').textContent = prefs.targets[i];
  $('#targetOvl').classList.add('on');
};
$('#btnTargetMinus').onclick = (e) => {
  e.preventDefault(); e.stopPropagation();
  let t = curTargetEdit;
  prefs.targets[t] = Math.max(1, Math.min(99, prefs.targets[t] - 1));
  $('#tvalEdit').textContent = prefs.targets[t];
  if($('#tval'+t)) $('#tval'+t).textContent = prefs.targets[t];
  lsSet(LS_PREFS, prefs); vib(8);
};
$('#btnTargetPlus').onclick = (e) => {
  e.preventDefault(); e.stopPropagation();
  let t = curTargetEdit;
  prefs.targets[t] = Math.max(1, Math.min(99, prefs.targets[t] + 1));
  $('#tvalEdit').textContent = prefs.targets[t];
  if($('#tval'+t)) $('#tval'+t).textContent = prefs.targets[t];
  lsSet(LS_PREFS, prefs); vib(8);
};

window.setCushGoal = function(n){
  prefs.cushGoal = n;
  lsSet(LS_PREFS, prefs); vib(8);
  syncCushSeg();
};
function syncCushSeg(){
  [0,1,2].forEach(n => { const b = $('#cushSeg'+n); if(b) b.classList.toggle('on', (prefs.cushGoal ?? 1) === n); });
}

window.applyMyBall = function(i) {
  if (!auth) return toast('로그인이 필요합니다.');
  
  if (prefs.gameType !== '팀전' && prefs.myBall !== i) {
    const other = i;
    const current = prefs.myBall;
    const tempName = prefs.names[current];
    const tempPid = prefs.pids[current];
    const tempTarget = prefs.targets[current];
    prefs.names[current] = prefs.names[other];
    prefs.pids[current] = prefs.pids[other];
    prefs.targets[current] = prefs.targets[other];
    prefs.names[other] = tempName;
    prefs.pids[other] = tempPid;
    prefs.targets[other] = tempTarget;
  }
  
  prefs.myBall = i;
  prefs.pids[i] = auth.uid;
  if (prefs.gameType !== '팀전') {
    const m = members.find(x => x.id === auth.uid);
    if (m && m.handicap != null) prefs.targets[i] = parseInt(m.handicap, 10);
  }
  lsSet(LS_PREFS, prefs);
  syncSetup(prefs.gameType === '팀전');
}

$('#btnStart').onclick = () => {
  const err = $('#sErr'); err.textContent = '';
  const isTeam = prefs.gameType === '팀전';
  const N = isTeam ? 4 : parseInt(prefs.gameType.replace('인',''), 10);
  const totalPlayers = N;
  
  let pNames = [], pPids = [], pTargets = [];
  for(let i=0; i<totalPlayers; i++){
    const nm = $('#name'+i) ? $('#name'+i).value.trim() : prefs.names[i];
    if(!nm && prefs.pids[i]) pNames.push(members.find(x => x.id === prefs.pids[i])?.display_name || '');
    else pNames.push(nm || '');
    pPids.push(prefs.pids[i] || null);
  }
  
  for(let i=0; i<totalPlayers; i++){
    if(!pNames[i]) return err.textContent = '모든 선수를 선택하거나 이름을 입력하세요';
  }
  
  if (isTeam) {
    pTargets = [prefs.targets[0], prefs.targets[1], prefs.targets[0], prefs.targets[1]];
  } else {
    for(let i=0; i<N; i++) pTargets.push(prefs.targets[i]);
  }
  
  prefs.names = pNames;
  prefs.pids = pPids;
  lsSet(LS_PREFS, prefs);
  
  S = {
    type: prefs.gameType,
    names: [...pNames], pids: [...pPids], targets: [...pTargets],
    sc: Array(N).fill(0), indSc: Array(N).fill(0),
    inn: Array(N).fill(0), br: Array(N).fill(0), miss: Array(N).fill(0),
    done: Array(N).fill(false),
    cush: Array(N).fill(0), indCush: Array(N).fill(0), cushInn: Array(N).fill(0),
    finished: Array(N).fill(false), rank: Array(N).fill(0),
    round: prefs.cushGoal || 1, lastInning: false, winners: [],
    tp: 0, turn: 0, first: 0, tc: 0,
    timeMs: Array(N).fill(0), turnStart: Date.now(),
    hist: [], fin: false, saved: false, t0: Date.now()
  };
  save(); buildGameZones(); render(); show('game');
  toast(`${isTeam ? TZNAMES[S.first] : S.names[S.first]} 선공으로 시작!`);
};

// ══ Game Logic ══
let ts = null;
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(ts); ts = setTimeout(()=>t.classList.remove('on'), 2500); };
const vib = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch(e){} };
function save(){ lsSet(LS_STATE, S); }

let wl = null;
async function wakeLock(){ try { wl = await navigator.wakeLock.request('screen'); } catch(e){} }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (S) wakeLock();
    if (S && S.timeMs && !S.fin && !S.paused) S.turnStart = Date.now();   // 백그라운드 대기 시간은 선수 시간에 넣지 않음
    queueFlush();
  }
  else save();
});

// 게임 시계: 총 경과 시간 표시 (일시정지된 시간은 제외)
setInterval(() => {
  if (!S || S.fin) return;
  const el = $('#gameClock');
  if (!el) return;
  if (S.paused) return;   // 일시정지 중엔 갱신 안 함(고정 표시)
  const pausedMs = S.pausedMs || 0;
  const secs = Math.floor((Date.now() - S.t0 - pausedMs) / 1000);
  el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}, 1000);

window.togglePause = function(){
  if (!S || S.fin) return;
  const now = Date.now();
  if (!S.paused) {
    // 일시정지 시작: 현재 턴 소모 시간을 마감하고, 시계·턴 누적을 멈춘다
    if (S.timeMs && S.turnStart != null) {
      S.timeMs[S.turn] = (S.timeMs[S.turn] || 0) + (now - S.turnStart);
    }
    S.turnStart = null;
    S.paused = true;
    S.pauseStart = now;
    $('#gameZones').classList.add('paused');
    if ($('#pauseOverlay')) $('#pauseOverlay').style.opacity = '1';
    $('#btnPause').innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  } else {
    // 재개: 정지 구간을 누적 정지시간에 더하고, 턴 타이머를 다시 시작
    S.pausedMs = (S.pausedMs || 0) + (now - (S.pauseStart || now));
    S.paused = false;
    S.turnStart = now;
    $('#gameZones').classList.remove('paused');
    if ($('#pauseOverlay')) $('#pauseOverlay').style.opacity = '0';
    $('#btnPause').innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  }
  save();
};

function buildGameZones() {
  if (!S) return;
  const isTeam = S.type === '팀전';
  const N = S.sc.length;
  // append zones to #game but keep #mid
  let gameHtml = '';
  for(let i=0; i<N; i++){
    let zname = (S.names && S.names[i]) ? S.names[i] : 'Player';
    if (isTeam && S.names) {
      zname = `${i%2 === 0 ? 'A팀' : 'B팀'} ${S.names[i]}`;
    }
    let tgt = (S.targets && S.targets[i]) ? S.targets[i] : 15;
    
    gameHtml += `
      <div class="zone" id="zone${i}">
        <button class="minusbtn" id="mbtn${i}">파울</button>
        <span class="runbadge" id="run${i}">+0</span>
        <div class="zname">
          <div class="zname-text"><span id="gball${i}"></span><span id="gname${i}">${esc(zname)}</span></div>
          <span class="turnchip">치는 중</span>
        </div>
        <div class="zscore" id="gsc${i}">0</div>
        <div class="zstats" id="gstat${i}">에버 0.000 · 하이런 0</div>
      </div>
    `;
  }
  
  // insert zones into #gameZones
  $('#gameZones').innerHTML = gameHtml;
  
  
  
  for(let i=0; i<N; i++){
    $('#zone'+i).addEventListener('pointerdown', e => {
      if (e.target.closest('.minusbtn')) return;
      tapZone(i);
    });
    $('#zone'+i).addEventListener('contextmenu', e => e.preventDefault());
    $('#mbtn'+i).addEventListener('pointerdown', e => { e.stopPropagation(); foul(i); });
  }
  
  if ($('#btnUndo')) {
    $('#btnUndo').onclick = e => { e.stopPropagation(); undoTurn(); };
  }
}

function pushHist(){
  S.hist.push(JSON.stringify({
    sc:[...S.sc], indSc: S.indSc ? [...S.indSc] : [...S.sc],
    inn:[...S.inn], br:[...S.br], miss:[...S.miss],
    done:[...S.done], cush:[...S.cush], indCush: S.indCush ? [...S.indCush] : [...S.cush], cushInn:[...S.cushInn],
    finished:[...S.finished], rank: S.rank ? [...S.rank] : [], round:S.round, lastInning:S.lastInning, winners:[...S.winners],
    tp:S.tp, turn:S.turn, first:S.first, tc:S.tc, fin:S.fin,
    timeMs: S.timeMs ? [...S.timeMs] : [], turnStart: S.turnStart
  }));
}

function popScore(i){
  const el = $('#gsc'+i);
  if(!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function nextTurnIndex(current) {
  const N = S.sc.length;
  let next = (current + 1) % N;
  let checked = 0;
  while (S.finished[next] && checked < N) {
    next = (next + 1) % N;
    checked++;
  }
  return next;
}

function activePlayerCount() {
  return S.finished.filter(x => !x).length;
}

function markGoalReached(i){
  S.lastInning = true;
  if (!S.winners.includes(i)) S.winners.push(i);
  if (S.type === '팀전' && S.sc.length === 4) { if (!S.winners.includes((i+2)%4)) S.winners.push((i+2)%4); }
  toast(`🎯 목표 달성!`);
}

function tapZone(i){
  if (!S || S.fin || S.finished[i] || S.paused) return;

  if (i === S.turn) {
    if (!S.done[i]) {
      pushHist();
      if (!S.indSc) S.indSc = [...S.sc];
      S.sc[i]++; S.indSc[i]++; S.tp++;
      if (S.type === '팀전' && S.sc.length === 4) S.sc[(i+2)%4]++;
      vib(12); popScore(i);
      if (S.sc[i] >= S.targets[i]) {
        S.done[i] = true;
        S.cushInn[i]++;
        if (S.type === '팀전' && S.sc.length === 4) { const p = (i+2)%4; S.done[p] = true; }
        if (S.round <= 0) {
          // 마무리 쿠션 0개 설정: 목표 도달 즉시 달성
          markGoalReached(i);
          passTurnInner(false, true);
        } else {
          toast(`🎯 마무리 쿠션!`);
        }
      }
    } else if (S.cush[i] < S.round) {
      pushHist();
      if (!S.indCush) S.indCush = [...S.cush];
      S.cush[i]++; S.indCush[i]++; S.tp++;
      if (S.type === '팀전' && S.sc.length === 4) S.cush[(i+2)%4]++;
      vib(12); popScore(i);
      if (S.tp > S.br[i]) S.br[i] = S.tp;

      if (S.cush[i] >= S.round) {
        // 설정한 쿠션 개수를 모두 채웠을 때만 목표 달성
        markGoalReached(i);
        passTurnInner(false, true);
      } else {
        toast(`🎯 쿠션 ${S.cush[i]}/${S.round}`);
      }
    } else {
      vib(8);
    }
  } else {
    passTurnInner(true);
  }
  save(); render();
}

function passTurnInner(isMiss, skipHist) {
  if (!skipHist) pushHist();
  if (S.tp > S.br[S.turn]) S.br[S.turn] = S.tp;
  if (isMiss && S.tp === 0) S.miss[S.turn]++;
  
  S.inn[S.turn]++; S.tp = 0;
  if (S.done[S.turn]) S.cushInn[S.turn]++;
  
  const prevTurn = S.turn;
  // 직전 선수가 이번 턴에 소모한 시간을 누적
  if (S.timeMs) {
    const nowT = Date.now();
    S.timeMs[prevTurn] = (S.timeMs[prevTurn] || 0) + (nowT - (S.turnStart || nowT));
    S.turnStart = nowT;
  }
  const next = nextTurnIndex(S.turn);
  S.turn = next;
  S.tc++;
  vib(25);
  
  const isTeam = S.type === '팀전' && S.sc.length === 4;
  const is2p = S.sc.length === 2;

  let inningEnded = false;
  if (isTeam || is2p) {
    const teamOf = i => isTeam ? (i % 2) : i;
    if (teamOf(prevTurn) !== teamOf(S.first)) inningEnded = true;
  } else {
    const activeInns = S.inn.filter((_, idx) => !S.finished[idx]);
    if (activeInns.length > 0 && activeInns.every(v => v === activeInns[0])) {
      inningEnded = true;
    }
  }

  if (inningEnded && S.lastInning) {
    endInning();
  }
}


function endInning() {
  const isTeam = S.type === '팀전' && S.sc.length === 4;
  const is2p = S.sc.length === 2;

  if (S.winners.length > 0) {
    if (isTeam || is2p) {
      const teamWins = new Set(S.winners.map(i => isTeam ? (i%2) : i));
      if (teamWins.size === 2) {
        S.round++;
        S.lastInning = false;
        S.winners = [];
        S.cushInn[S.first]++;
        vib([40,40,40]);
        toast(`동점! 마무리 쿠션 ${S.round} — 연장`);
        return;
      }
      save(); render(); return win(S.winners[0]);
    } else {
      save(); render(); return win(S.winners[0]);
    }
  }
}

window.undoTurn = function(){
  if (!S || !S.hist.length) return;
  try {
    const h = JSON.parse(S.hist.pop());
    Object.assign(S, h);
    vib(15); save(); render();
  } catch(e){}
};

// 파울: 현재 치는 선수의 점수를 실제로 1점 깎고(음수 허용) 턴을 넘긴다.
window.foul = function(i){
  if (!S || S.fin || i !== S.turn || S.finished[i] || S.paused) return;
  pushHist();
  S.sc[i]--; if (S.indSc) S.indSc[i]--;
  // 이미 목표를 달성해 마무리 쿠션 중이었는데 점수가 목표 밑으로 내려가면 완주 상태 해제
  if (S.done[i] && S.sc[i] < S.targets[i]) {
    S.done[i] = false;
    S.cush[i] = 0; if (S.indCush) S.indCush[i] = 0;
    S.lastInning = false;
    S.winners = S.winners.filter(x => x !== i && x !== ((i+2)%4));
  }
  if (S.type === '팀전' && S.sc.length === 4) {
    const p = (i+2)%4;
    S.sc[p] = S.sc[i]; S.done[p] = S.done[i]; S.cush[p] = S.cush[i];
    if (S.indSc) S.indSc[p] = S.indSc[i];
    if (S.indCush) S.indCush[p] = S.indCush[i];
  }
  vib(30); popScore(i);
  toast('⚠️ 파울 −1');
  // 파울은 이닝 종료 → 턴 넘김 (스냅샷은 위에서 이미 저장했으므로 skipHist)
  passTurnInner(true, true);
  save(); render();
};

function render(){
  if (!S) return;
  const isTeam = S.type === '팀전';
  const N = S.sc.length;
  for(let i=0; i<N; i++) {
    const el = $('#zone'+i);
    if(!el) continue;
    
    el.classList.toggle('on', S.turn === i && !S.fin && !S.finished[i]);
    el.classList.toggle('off', (S.turn !== i || S.fin) && !S.finished[i]);
    if (S.finished[i]) {
      el.style.opacity = '0.3';
      el.classList.add('off');
    } else {
      el.style.opacity = '1';
    }
    
    // 계산: 이 선수가 칠 때의 절대 턴수(tc)
    let expectedTc = S.tc;
    if (!S.finished[i]) {
      let curr = S.turn;
      while (curr !== i) {
        curr = (curr + 1) % N;
        if (!S.finished[curr]) expectedTc++;
      }
    }
    const isWhite = (expectedTc % 2 === 0);
    el.classList.toggle('w', isWhite);
    el.classList.toggle('y', !isWhite);
    
    const ballSpan = $('#gball'+i);
    if (ballSpan) {
      ballSpan.textContent = isWhite ? '⚪ ' : '🟡 ';
      ballSpan.style.marginRight = '4px';
    }
    
    if (S.done[i] && S.round > 0) {
      $('#gsc'+i).innerHTML = `${S.cush[i]}<span style="font-size:0.45em;opacity:0.55;font-weight:700"> / ${S.round}</span>`;
      $('#gstat'+i).innerHTML = `<span style="color:var(--accent)">마무리 쿠션 단계</span>`;
      $('#gsc'+i).style.fontSize = 'clamp(40px, 15vmin, 100px)';
    } else {
      $('#gsc'+i).innerHTML = `${S.sc[i]}<span style="font-size:0.45em;opacity:0.55;font-weight:700"> / ${S.targets[i]}</span>`;
      const ev = S.inn[i] ? (S.sc[i] / S.inn[i]).toFixed(3) : '0.000';
      $('#gstat'+i).textContent = `에버 ${ev} · 하이런 ${S.br[i]}`;
      $('#gsc'+i).style.fontSize = 'clamp(64px, 22vmin, 150px)';
    }
    
    if (S.turn === i && S.tp > 0) {
      $('#run'+i).textContent = '+' + S.tp;
      $('#run'+i).classList.add('show');
    } else {
      $('#run'+i).classList.remove('show');
    }
  }
  
  if ($('#inning')) {
    $('#inning').textContent = `${Math.max(...S.inn) + 1} 이닝`;
  }
}

// ══ Win / Menu ══
// 이번 라운드 승자를 등수에 반영 (동시 달성이면 같은 등수). 아직 못 끝낸 팀/개인 수를 반환.
function assignRanksAndCountRemaining(){
  const isTeam = S.type === '팀전';
  if (!S.rank) S.rank = Array(S.sc.length).fill(0);
  const nextRank = Math.max(0, ...S.rank) + 1;
  S.winners.forEach(w => { if (!S.rank[w]) S.rank[w] = nextRank; });
  // 남은 유닛 수 (팀전은 팀 기준, 개인전은 사람 기준)
  const doneUnits = new Set();
  S.rank.forEach((r, i) => { if (r) doneUnits.add(isTeam ? i % 2 : i); });
  const total = isTeam ? 2 : S.sc.length;
  return total - doneUnits.size;
}

// 게임 종료 시 최종 기록을 서버에 저장 (등수 확정 · 못 끝낸 선수는 공동 꼴찌)
function saveGame(){
  if (S.saved) return;
  S.saved = true; save();
  if (!auth) {
    $('#saveStat').className = 'savestat'; $('#saveStat').textContent = '게스트 모드: 기록이 저장되지 않습니다';
    return;
  }
  const N = S.sc.length, isTeam = S.type === '팀전';
  // 마지막(현재) 턴의 진행 시간을 마감 처리
  if (S.timeMs && S.turnStart != null) {
    S.timeMs[S.turn] = (S.timeMs[S.turn] || 0) + (Date.now() - S.turnStart);
    S.turnStart = Date.now();
  }
  const lastRank = Math.max(0, ...S.rank) + 1;   // 끝까지 못 친 선수들의 공동 등수
  const pl = [];
  for (let i = 0; i < N; i++) {
    const rank = S.rank[i] || lastRank;
    const indS = (S.indSc && S.indSc[i] !== undefined) ? S.indSc[i] : S.sc[i];
    const indC = (S.indCush && S.indCush[i] !== undefined) ? S.indCush[i] : S.cush[i];
    pl.push({
      id: S.pids[i] || null, name: S.names[i], win: rank === 1, rank,
      score: indS, target: S.targets[i], innings: S.inn[i],
      highRun: S.br[i], misses: S.miss[i], cushMade: indC,
      cushInn: S.cushInn[i], timeMs: (S.timeMs && S.timeMs[i]) || 0, isTeam
    });
  }
  const payload = { recorded_by: auth.uid, played_at: new Date(S.t0).toISOString(), players: pl };
  $('#saveStat').className = 'savestat'; $('#saveStat').textContent = '서버에 기록 저장 중...';
  api.submitGame(payload).then(() => {
    $('#saveStat').className = 'savestat ok'; $('#saveStat').textContent = '기록 저장 완료 ✓';
  }).catch(() => {
    queueAdd(payload);
    $('#saveStat').className = 'savestat warn'; $('#saveStat').textContent = '오프라인: 나중에 저장됩니다';
  });
}

function win(winnerIdx){
  S.fin = true;
  const isTeam = S.type === '팀전';
  const N = S.sc.length;
  const remaining = assignRanksAndCountRemaining();
  const isFinal = remaining <= 1;   // 남은 유닛이 1 이하면 더 겨룰 상대가 없음 → 경기 종료
  save();
  const winOvl = $('#winOvl');
  winOvl.classList.add('on');
  // 마지막 점수 탭이 방금 뜬 결과 메뉴 버튼으로 관통되는 것 방지: 잠깐 입력을 무시
  winOvl.style.pointerEvents = 'none';
  setTimeout(() => { winOvl.style.pointerEvents = ''; }, 600);

  const isTie = isTeam && N === 4 ? new Set(S.winners.map(i => i%2)).size > 1 : S.winners.length > 1;
  const first = S.winners[0];
  const placeLabel = (S.rank[first] || 1) === 1 ? '승리' : `${S.rank[first]}위 확정`;
  $('#winTitle').textContent = isTie
    ? '공동 달성!'
    : `${isTeam ? TZNAMES[first%2] : S.names[first]} ${placeLabel}!`;

  let html = '<tr><th>선수</th><th>점수</th><th>에버</th><th>하이런</th></tr>';
  for(let i=0; i<N; i++){
    const nm = isTeam ? `${i%2===0 ? 'A팀' : 'B팀'} ${S.names[i]}` : S.names[i];
    const indS = (S.indSc && S.indSc[i] !== undefined) ? S.indSc[i] : S.sc[i];
    const indC = (S.indCush && S.indCush[i] !== undefined) ? S.indCush[i] : S.cush[i];
    const scStr = (S.done[i] && S.round > 0) ? `쿠션 ${indC}/${S.round}` : `${indS}/${S.targets[i]}`;
    const ev = S.inn[i] ? (indS / S.inn[i]).toFixed(3) : '0.000';
    const rankTag = S.rank[i] ? ` <span style="opacity:.6">${S.rank[i]}위</span>` : '';
    html += `<tr><td>${esc(nm)}${rankTag}</td><td>${scStr}</td><td>${ev}</td><td>${S.br[i]}</td></tr>`;
  }
  $('#winStats').innerHTML = html;

  // 아직 겨룰 선수가 남았으면 '계속치기'로 꼴등전 진행, 최종이면 여기서 저장
  $('#btnWinCont').style.display = isFinal ? 'none' : '';
  if (isFinal) saveGame();
}

// 경기 종료(저장) 후 새 경기 — 꼴등전을 안 하고 바로 끝낼 때도 여기서 저장된다
$('#btnWinNew').onclick = () => {
  saveGame();
  $('#winOvl').classList.remove('on'); S = null; save(); show('setup');
};

$('#btnWinCont').onclick = () => {
  $('#winOvl').classList.remove('on');
  S.winners.forEach(w => S.finished[w] = true);
  S.winners = [];
  S.lastInning = false;
  S.fin = false;

  if (activePlayerCount() <= 1) {
    toast('더 이상 진행할 선수가 없습니다.');
    S.fin = true; saveGame(); return;
  }

  // Set turn to the next non-finished player if current is finished
  if (S.finished[S.turn]) S.turn = nextTurnIndex(S.turn);
  save(); render();
};

$('#btnWinUndo').onclick = () => {
  $('#winOvl').classList.remove('on');
  S.fin = false; S.saved = false;
  undoTurn();
};

$('#btnMenu').onclick = () => $('#menuOvl').classList.add('on');
$('#btnMenuClose').onclick = () => $('#menuOvl').classList.remove('on');
$('#btnMenuNew').onclick = () => {
  if(confirm('진행 중인 경기가 사라집니다. 새 경기를 설정할까요?')){
    $('#menuOvl').classList.remove('on'); S = null; save(); show('setup');
  }
};
$('#btnMenuRestart').onclick = () => {
  if(confirm('점수를 모두 0으로 초기화할까요?')){
    $('#menuOvl').classList.remove('on');
    const N = S.sc.length;
    Object.assign(S, { sc:Array(N).fill(0), inn:Array(N).fill(0), br:Array(N).fill(0), miss:Array(N).fill(0),
                       done:Array(N).fill(false), cush:Array(N).fill(0), cushInn:Array(N).fill(0),
                       finished:Array(N).fill(false), round:prefs.cushGoal||1, lastInning:false, winners:[],
                       tp:0, turn:S.first, tc:0, timeMs:Array(N).fill(0), turnStart:Date.now(),
                       hist:[], fin:false, saved:false, t0:Date.now() });
    save(); buildGameZones(); render(); toast('점수가 초기화되었습니다.');
  }
};
document.querySelectorAll('.ovl').forEach(o => o.addEventListener('pointerdown', e => { if (e.target === o) o.classList.remove('on'); }));
$('#targetOvl').addEventListener('pointerdown', e => { if (e.target === $('#targetOvl')) $('#targetOvl').classList.remove('on'); });
$('#btnTargetClose').onclick = () => $('#targetOvl').classList.remove('on');

// ══ Queue & Init ══
function queueAdd(p){ const q = lsGet(LS_QUEUE, []); q.push(p); lsSet(LS_QUEUE, q); }
async function queueFlush(){
  if (!navigator.onLine) return;
  let q = lsGet(LS_QUEUE, []);
  if (!q.length) return;
  let newQ = [];
  let sent = 0;
  for (const p of q) {
    try {
      await api.submitGame(p);
      sent++;
    } catch(e) {
      // 회복 가능한 실패는 대기열에 남긴다:
      //  - status 없음 → 네트워크 오류 (fetch 실패)
      //  - 401 토큰 만료, 429 과다요청, 5xx 서버 장애
      // 진짜 잘못된 요청(400/409/422 등)만 폐기해 큐가 막히지 않게 한다.
      const s = e.status;
      const recoverable = !s || s === 401 || s === 429 || s >= 500;
      if (recoverable) newQ.push(p);
      else console.error('Discarding bad payload', e);
    }
  }
  lsSet(LS_QUEUE, newQ);
  if (sent > 0) toast(`오프라인 기록 ${sent}건 동기화 완료!`);
}

function init(){
  setMode('login');
  if (auth) { if (auth.loginId) $('#aId').value = auth.loginId; loadMembers().then(()=>queueFlush()); }
  else { show('auth'); }

  // 구버전 상태 마이그레이션: finished 배열이 없으면 추가
  if (S && S.sc) {
    if (!Array.isArray(S.finished)) {
      const N = S.sc.length;
      S.finished = Array(N).fill(false);
      S.winners = S.winners || [];
      S.lastInning = S.lastInning || false;
      S.round = S.round || 1;
      if (!S.type) S.type = '2인';
    }
    if (!Array.isArray(S.rank)) {
      S.rank = Array(S.sc.length).fill(0);
    }
    if (typeof S.tc !== 'number') {
      S.tc = S.inn.reduce((a, b) => a + b, 0);
    }
    if (!Array.isArray(S.timeMs)) { S.timeMs = Array(S.sc.length).fill(0); S.turnStart = Date.now(); }
    save();
  }

  if (S && S.sc && !S.fin) {
    buildGameZones(); render(); show('game'); queueFlush();
    if (S.paused) {
      $('#gameZones').classList.add('paused');
      $('#btnPause').textContent = '►';
      // 앱이 백그라운드/종료돼 있던 동안은 일시정지 구간에 포함시켜 시계에서 계속 제외
      S.pauseStart = Date.now();
    }
  } else if (auth) {
    syncSetup(); show('setup');
  }
}
window.addEventListener('online', queueFlush);
init();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.getRegistrations().then(regs => {
    for(let r of regs) {
      if(r.scope !== location.origin + '/Dangdong/') r.unregister();
    }
  });
  navigator.serviceWorker.register('../sw.js').catch(()=>{});
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) { refreshing = true; window.location.reload(); }
  });
}
