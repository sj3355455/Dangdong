// 당동 공통 모듈 — score/ 와 record/ 가 공유 (테마 · 서비스워커 등록 · 팀 설정 모달)
import { sbFetch } from './supabase.js';

const $id = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

// ── 테마 ──
export const LS_THEME = 'dangTheme';
export const getTheme = () => { try { return localStorage.getItem(LS_THEME) || 'system'; } catch(e){ return 'system'; } };
export function applyTheme(t){
  const r = document.documentElement;
  if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t);
  else r.removeAttribute('data-theme');
}

// ── 서비스워커 등록 + 무중단 자동 업데이트 ──
// sw.js 의 VERSION 변경 → 새 워커 설치·활성화 → controllerchange → 앱 자동 1회 새로고침. 폴링 없음.
export function registerSW(){
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  // 푸터 버전 표시 = sw.js 의 VERSION (단일 소스). SW 가 메시지로 알려준다.
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'appVersion') {
      document.querySelectorAll('[data-app-version]').forEach(el => el.textContent = e.data.version);
    }
  });
  navigator.serviceWorker.register('../sw.js', { updateViaCache: 'none' }).then(reg => {
    // 앱을 다시 열 때 새 배포 확인(모바일 백그라운드 복귀 대응). 폴링 아님.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
    const askVersion = () => { const sw = navigator.serviceWorker.controller; if (sw) sw.postMessage('getVersion'); };
    if (navigator.serviceWorker.controller) askVersion();
    else navigator.serviceWorker.ready.then(askVersion);
  }).catch(() => {});
}

// ── 팀 설정 모달 (팀 참가 / 팀 만들기 / 팀장: 코드·이름 변경·팀원 내보내기) ──
// ctx 로 앱별 차이만 주입한다:
//   getAuth()            현재 로그인 정보
//   getCurrentTeam()     현재 팀 id
//   setCurrentTeam(id)   현재 팀 지정 + localStorage 저장
//   getMyTeams()         내 소속 팀 배열
//   reloadTeams()        (async) 앱의 loadTeams — myTeams·currentTeam·팀 스위처 갱신
//   afterChange()        (async) 앱별 데이터/화면 갱신 (점수판: 멤버+설정 / 기록실: 데이터+탭)
//   notify(msg)          (선택) 토스트 — 점수판만 사용
export function initTeamModal(ctx){
  const modal = $id('teamModal');

  // 팀장일 때만: 초대코드 표시/변경 + 팀원 내보내기
  async function renderLeaderSection(){
    const box = $id('tmLeader'); if (!box) return;
    const cur = ctx.getCurrentTeam();
    const me = ctx.getMyTeams().find(t => t.id === cur);
    if (!cur || !me) { box.style.display = 'none'; return; }   // 팀 없거나 비회원만 숨김
    box.style.display = 'block';
    const isLeader = !!me.is_admin;
    $id('tmCodeRow').style.display = isLeader ? 'flex' : 'none';   // 코드 변경은 팀장만
    $id('tmNameRow').style.display = isLeader ? 'flex' : 'none';   // 이름 변경도 팀장만
    if (isLeader) $id('tmTeamName').value = me.name || '';
    $id('tmRoster').innerHTML = '';
    try {
      if (isLeader) {
        $id('tmCurCode').value = '';
        const code = await sbFetch('/rest/v1/rpc/team_join_code', { method: 'POST', body: JSON.stringify({ p_team_id: cur }) });
        $id('tmCurCode').value = code || '';
      }
      const rows = await sbFetch('/rest/v1/team_members?select=user_id,is_admin,profiles(display_name)&team_id=eq.' + cur);
      const auth = ctx.getAuth(); const myUid = auth && auth.uid;
      $id('tmRoster').innerHTML = (rows || []).map(r => {
        const nm = (r.profiles && r.profiles.display_name) || r.user_id;
        const self = r.user_id === myUid;
        const right = (isLeader && !self)   // 내보내기 버튼은 팀장에게만
          ? `<button class="tmKick" data-uid="${esc(r.user_id)}" data-nm="${esc(nm)}" style="flex:0 0 auto; padding:6px 10px; border-radius:8px; background:var(--card); color:var(--danger,#e5484d); border:1px solid var(--line); font-size:.8rem; cursor:pointer;">내보내기</button>`
          : (self ? '<span style="color:var(--muted); font-size:.8rem;">나</span>' : '');
        return `<div style="display:flex; align-items:center; gap:8px;">
        <span style="flex:1 1 auto; min-width:0;">${esc(nm)}${r.is_admin ? ' 👑' : ''}</span>
        ${right}
      </div>`;
      }).join('');
      if (isLeader) $id('tmRoster').querySelectorAll('.tmKick').forEach(b => b.onclick = async () => {
        if (!confirm(`${b.dataset.nm}님을 팀에서 내보낼까요?`)) return;
        try {
          await sbFetch('/rest/v1/rpc/remove_member', { method: 'POST', body: JSON.stringify({ p_team_id: cur, p_user_id: b.dataset.uid }) });
          await ctx.afterChange(); renderLeaderSection();
        } catch(e){ alert('내보내기에 실패했어요'); }
      });
    } catch(e){ box.style.display = 'none'; }
  }

  function open(){
    if (!modal) return;
    $id('tmCode').value = ''; $id('tmName').value = ''; $id('tmMsg').textContent = '';
    modal.style.display = 'flex';
    renderLeaderSection();
  }
  function close(){ if (modal) modal.style.display = 'none'; }

  if (modal) {
    $id('tmClose').onclick = close;
    modal.onclick = e => { if (e.target === modal) close(); };

    $id('tmJoin').onclick = async () => {
      const msg = $id('tmMsg');
      const code = ($id('tmCode').value || '').trim().toUpperCase();
      if (!code) { msg.textContent = '참여 코드를 입력하세요'; return; }
      msg.textContent = '참가하는 중...';
      try {
        const tid = await sbFetch('/rest/v1/rpc/join_team', { method: 'POST', body: JSON.stringify({ code }) });
        ctx.setCurrentTeam(tid);
        await ctx.reloadTeams(); await ctx.afterChange();
        close(); if (ctx.notify) ctx.notify('팀에 참여했어요!');
      } catch(e){ msg.textContent = /invalid_code/.test(e.message) ? '참여 코드가 올바르지 않아요' : '참가에 실패했어요'; }
    };

    $id('tmCreate').onclick = async () => {
      const msg = $id('tmMsg');
      const name = ($id('tmName').value || '').trim();
      if (!name) { msg.textContent = '팀 이름을 입력하세요'; return; }
      msg.textContent = '만드는 중...';
      try {
        const r = await sbFetch('/rest/v1/rpc/create_team', { method: 'POST', body: JSON.stringify({ team_name: name }) });
        const t = Array.isArray(r) ? r[0] : r;
        ctx.setCurrentTeam(t.id);
        await ctx.reloadTeams(); await ctx.afterChange();
        $id('tmName').value = '';
        $id('tmMsg').innerHTML = `✅ "${esc(t.name)}" 팀 생성 완료<br>참여 코드: <b style="font-size:1.05rem">${esc(t.join_code)}</b><br><span style="color:var(--muted)">이 코드를 부원에게 공유하세요.</span>`;
      } catch(e){
        if (/name_taken|duplicate|unique/i.test(e.message)) msg.textContent = '이미 사용 중인 팀 이름입니다. 다른 이름을 입력해 주세요';
        else if (/not_authenticated/i.test(e.message)) msg.textContent = '로그인이 만료되었습니다. 다시 로그인해 주세요';
        else msg.textContent = '팀 만들기에 실패했어요 (' + (e.message || '오류') + ')';
      }
    };

    $id('tmRegen').onclick = async () => {
      const msg = $id('tmMsg');
      const code = ($id('tmCurCode').value || '').trim().toUpperCase();
      if (!code) { msg.textContent = '초대 코드를 입력하세요'; return; }
      msg.textContent = '변경 중...';
      try {
        const saved = await sbFetch('/rest/v1/rpc/set_join_code', { method: 'POST', body: JSON.stringify({ p_team_id: ctx.getCurrentTeam(), new_code: code }) });
        $id('tmCurCode').value = saved;
        msg.textContent = '초대 코드가 변경되었습니다.';
      } catch(e){
        if (/not_authorized/.test(e.message)) msg.textContent = '팀장 권한이 없어 코드를 변경할 수 없어요';
        else if (/code_taken|duplicate|unique/i.test(e.message)) msg.textContent = '이미 사용 중인 참여 코드입니다. 다른 코드를 입력해 주세요';
        else msg.textContent = '코드 변경에 실패했어요';
      }
    };

    $id('tmRename').onclick = async () => {
      const msg = $id('tmMsg');
      const name = ($id('tmTeamName').value || '').trim();
      if (!name) { msg.textContent = '팀 이름을 입력하세요'; return; }
      msg.textContent = '변경 중...';
      try {
        await sbFetch('/rest/v1/rpc/rename_team', { method: 'POST', body: JSON.stringify({ p_team_id: ctx.getCurrentTeam(), new_name: name }) });
        await ctx.reloadTeams();   // 스위처 이름 갱신
        renderLeaderSection();
        msg.textContent = '팀 이름이 변경되었습니다.';
      } catch(e){ msg.textContent = /name_taken|duplicate|unique/i.test(e.message) ? '이미 사용 중인 팀 이름입니다. 다른 이름을 입력해 주세요' : '이름 변경에 실패했어요'; }
    };

    // 팀 나가기 — 현재 팀에서 본인 소속 해제 (팀장은 최고참에게 자동 위임 후 나감)
    const leaveBtn = $id('tmLeave');
    if (leaveBtn) leaveBtn.onclick = async () => {
      const cur = ctx.getCurrentTeam();
      const me = ctx.getMyTeams().find(t => t.id === cur);
      if (!cur || !me) return;
      if (!confirm(`"${me.name}" 팀에서 나가시겠어요?`)) return;
      const msg = $id('tmMsg');
      msg.textContent = '나가는 중...';
      try {
        await sbFetch('/rest/v1/rpc/leave_team', { method: 'POST', body: JSON.stringify({ p_team_id: cur }) });
        ctx.setCurrentTeam(null);            // reloadTeams 가 남은 팀 중 하나(또는 없음)로 재설정
        await ctx.reloadTeams(); await ctx.afterChange();
        renderLeaderSection();
        msg.textContent = '팀에서 나갔습니다.';
        if (ctx.notify) ctx.notify('팀에서 나갔어요');
      } catch(e){ msg.textContent = '나가기에 실패했어요'; }
    };
  }

  return { open };
}
