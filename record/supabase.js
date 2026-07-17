// Supabase 공통 모듈 — score/index.html 에서 import
const SB_URL = 'https://ezwassqurbmzcjfmtjop.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6d2Fzc3F1cmJtemNqZm10am9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjMxOTIsImV4cCI6MjA5OTc5OTE5Mn0.O6eHOO4-yxW7HVmNVjOkakrcoEeF5tORylhG1j79BeU';

function getAuth() {
  try { const v = localStorage.getItem('dangScoreAuth'); return v ? JSON.parse(v) : null; } catch(e){ return null; }
}

async function refreshToken(){
  const auth = getAuth();
  if (!auth || !auth.refresh) return false;
  try {
    const r = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
      method:'POST', headers:{ apikey: SB_KEY, 'Content-Type':'application/json' },
      body: JSON.stringify({ refresh_token: auth.refresh })
    });
    const d = await r.json();
    if (!r.ok || !d.access_token) return false;
    auth.token = d.access_token;
    auth.refresh = d.refresh_token;
    try { localStorage.setItem('dangScoreAuth', JSON.stringify(auth)); } catch(e){}
    return true;
  } catch(e){ return false; }
}

export async function sbFetch(path, opts = {}, retry = true){
  const auth = getAuth();
  const h = Object.assign({ apikey: SB_KEY, 'Content-Type': 'application/json' }, opts.headers || {});
  if (auth && auth.token) h['Authorization'] = 'Bearer ' + auth.token;
  const res = await fetch(SB_URL + path, Object.assign({}, opts, { headers: h }));
  if (res.status === 401 && retry && auth && auth.refresh) {
    if (await refreshToken()) return sbFetch(path, opts, false);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch(e){ body = text; }
  if (!res.ok) {
    const msg = (body && (body.msg || body.message || body.error_description)) || ('오류 ' + res.status);
    throw Object.assign(new Error(msg), { status: res.status, body });
  }
  return body;
}

function syntheticEmail(name){
  const norm = name.normalize('NFC').trim();
  const leads = ['g','gg','n','d','dd','r','m','b','bb','s','ss','','j','jj','ch','k','t','p','h'];
  const vowels = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
  const tails = ['','g','gg','gs','n','nj','nh','d','l','lg','lm','lb','ls','lt','lp','lh','m','b','bs','s','ss','ng','j','ch','k','t','p','h'];
  
  let res = '';
  for(let i=0; i<norm.length; i++){
    const code = norm.charCodeAt(i);
    if(code >= 0xAC00 && code <= 0xD7A3){
      const offset = code - 0xAC00;
      const l = Math.floor(offset / 588);
      const v = Math.floor((offset % 588) / 28);
      const t = offset % 28;
      
      if (i === 0) {
        if (norm[0] === '김') { res += 'kim'; continue; }
        if (norm[0] === '박') { res += 'park'; continue; }
        if (norm[0] === '최') { res += 'choi'; continue; }
      }
      res += leads[l] + vowels[v] + tails[t];
    } else {
      res += norm[i].toLowerCase();
    }
  }
  return `${res.replace(/[^a-z0-9]/g, '')}@dangdong.app`;
}

export async function sbAuth(name, password, isSignup){
  const email = syntheticEmail(name);
  const path = isSignup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
  const r = await fetch(SB_URL + path, {
    method:'POST', headers:{ apikey: SB_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({ email, password })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.msg || d.error_description || d.message || '요청 실패');
  if (!d.access_token) throw new Error('이메일 인증이 필요한 계정입니다');
  return { token: d.access_token, refresh: d.refresh_token, uid: d.user.id };
}
