'use strict';

// ── 상태 ──────────────────────────────────────────────
const API = '';
const TODAY = new Date().toISOString().split('T')[0];
let currentUser = null; // { token, role, name, email, id }
let meds = [];
let medChecks = [];

// ── 유틸 ──────────────────────────────────────────────
function showToast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ── 웹 알림 (Web Notification API) ─────────────────────
function requestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function caringNotify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'caring-' + Date.now() });
  } catch(e) {}
}

// 복약 시간 문자열 → HH:MM 변환
function parseMedTime(timeStr) {
  const map = {
    '아침 8시': '08:00', '아침 9시': '09:00', '점심 12시': '12:00',
    '오후 2시': '14:00', '저녁 6시': '18:00', '저녁 7시': '19:00',
    '취침 전 10시': '22:00'
  };
  return map[timeStr] || null;
}

// 복약 알림 스케줄러
function scheduleMedAlerts() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // 기존 타이머 정리
  if (window._medAlertTimers) window._medAlertTimers.forEach(clearTimeout);
  window._medAlertTimers = [];

  const now = new Date();
  meds.forEach((med, idx) => {
    const t = parseMedTime(med.time);
    if (!t) return;
    const [h, m] = t.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now) return; // 이미 지난 시간

    const ms = target - now;
    const timer = setTimeout(() => {
      const isDone = medChecks.includes(idx);
      if (!isDone) {
        caringNotify(
          '💊 복약 시간입니다',
          `${med.name} 복약할 시간이에요! (${med.time})`
        );
      }
    }, ms);
    window._medAlertTimers.push(timer);
  });

  // 저녁 9시 미완료 경고
  const evening = new Date(now);
  evening.setHours(21, 0, 0, 0);
  if (evening > now) {
    const timer = setTimeout(() => {
      const undone = meds.filter((_, i) => !medChecks.includes(i));
      if (undone.length > 0) {
        caringNotify(
          '⚠️ 복약 확인하세요',
          `오늘 ${undone.map(m => m.name).join(', ')} 복약을 확인해주세요.`
        );
      }
    }, evening - now);
    window._medAlertTimers.push(timer);
  }
}


function loadData() {
  const raw = localStorage.getItem('caring_user');
  if (raw) currentUser = JSON.parse(raw);
  meds = JSON.parse(localStorage.getItem('caring_meds') || '[]');
  medChecks = JSON.parse(localStorage.getItem('caring_checks_' + TODAY) || '[]');
}

function saveUser() { localStorage.setItem('caring_user', JSON.stringify(currentUser)); }
function saveMeds() { localStorage.setItem('caring_meds', JSON.stringify(meds)); }
function saveChecks() { localStorage.setItem('caring_checks_' + TODAY, JSON.stringify(medChecks)); }

function isDemoSession(user) {
  return Boolean(user?.token && String(user.token).startsWith('demo-token-'));
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function revalidateStoredSession(storedUser, fetchImpl = fetch) {
  if (!storedUser?.token) {
    return {
      ok: false,
      error: 'MISSING_SESSION',
      message: '저장된 로그인 정보가 없습니다.',
    };
  }

  if (isDemoSession(storedUser)) {
    return {
      ok: false,
      error: 'DEMO_SESSION',
      message: '데모 세션은 새로고침 후 유지되지 않습니다. 다시 로그인해주세요.',
    };
  }

  try {
    const response = await fetchImpl('/api/v1/users/me', {
      headers: {
        Authorization: 'Bearer ' + storedUser.token,
      },
    });
    const payload = await readJsonSafe(response);

    if (!response.ok) {
      return {
        ok: false,
        error: payload?.error || 'INVALID_SESSION',
        message: payload?.message || '저장된 세션을 다시 확인할 수 없습니다. 다시 로그인해주세요.',
      };
    }

    const user = payload?.data || payload?.user || payload;
    if (!user?.id || !user?.role) {
      return {
        ok: false,
        error: 'INVALID_SESSION_PAYLOAD',
        message: '세션 확인 응답 형식이 올바르지 않습니다.',
      };
    }

    if (storedUser.role && user.role !== storedUser.role) {
      return {
        ok: false,
        error: 'ROLE_MISMATCH',
        message: '저장된 역할 정보가 서버 세션과 일치하지 않습니다.',
      };
    }

    return {
      ok: true,
      user: {
        token: storedUser.token,
        role: user.role,
        name: user.display_name || storedUser.name || '',
        email: user.email || storedUser.email || '',
        id: user.id,
      },
    };
  } catch {
    return {
      ok: false,
      error: 'SESSION_REVALIDATION_FAILED',
      message: '서버에 연결할 수 없어 저장된 세션을 복원하지 않았습니다. 다시 로그인해주세요.',
    };
  }
}

function normalizeAdminUsersPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return null;
}

function buildAdminUsersViewModel(options) {
  if (options?.mode === 'ready') {
    const users = Array.isArray(options.users) ? options.users : [];
    const guardians = users.filter(user => user.role === 'guardian').length;
    const elders = users.filter(user => user.role === 'elder').length;
    return {
      mode: 'ready',
      stats: {
        total: users.length,
        guardians,
        elders,
      },
      rows: users,
      message: users.length ? '' : '등록된 사용자가 없습니다.',
    };
  }

  const suffix = options?.message ? ' ' + options.message : '';
  return {
    mode: options?.mode || 'error',
    stats: {
      total: '—',
      guardians: '—',
      elders: '—',
    },
    rows: [],
    message: options?.mode === 'demo'
      ? (options.message || '데모 관리자 계정은 실사용자 목록을 조회할 수 없습니다.')
      : ('실데이터를 불러오지 못했습니다.' + suffix).trim(),
  };
}

function ensureAdminStatusNote() {
  let note = document.getElementById('a-user-status-note');
  if (note) return note;

  const stats = document.getElementById('a-user-stats');
  if (!stats?.parentNode) return null;

  note = document.createElement('div');
  note.id = 'a-user-status-note';
  note.className = 'info-banner';
  note.style.display = 'none';
  stats.parentNode.insertBefore(note, stats);
  return note;
}

function renderAdminUsersViewModel(viewModel) {
  const tbody = document.getElementById('a-user-table-body');
  const note = ensureAdminStatusNote();

  document.getElementById('a-total-users').textContent = String(viewModel.stats.total);
  document.getElementById('a-guardian-count').textContent = String(viewModel.stats.guardians);
  document.getElementById('a-elder-count').textContent = String(viewModel.stats.elders);

  if (note) {
    note.textContent = viewModel.message || '';
    note.style.display = viewModel.message ? 'flex' : 'none';
  }

  if (viewModel.mode !== 'ready') {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--t3)">${viewModel.message}</td></tr>`;
    return;
  }

  if (!viewModel.rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--t3)">등록된 사용자가 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = viewModel.rows.map(u => `<tr>
    <td>${u.display_name}</td>
    <td style="color:var(--t3)">${u.email}</td>
    <td><span class="role-tag ${u.role}">${u.role === 'guardian' ? '보호자' : u.role === 'elder' ? '어르신' : u.role}</span></td>
    <td style="color:var(--t3);font-size:.75rem">${u.created_at ? String(u.created_at).slice(0,10) : '—'}</td>
  </tr>`).join('');
}

// ── 인증 탭 전환 ──────────────────────────────────────
function setupAuthTabs() {
  document.getElementById('tab-login').addEventListener('click', () => {
    document.getElementById('tab-login').classList.add('on');
    document.getElementById('tab-register').classList.remove('on');
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('register-form').style.display = 'none';
    clearAuthErr();
  });
  document.getElementById('tab-register').addEventListener('click', () => {
    document.getElementById('tab-register').classList.add('on');
    document.getElementById('tab-login').classList.remove('on');
    document.getElementById('register-form').style.display = 'block';
    document.getElementById('login-form').style.display = 'none';
    clearAuthErr();
  });
}

function showAuthErr(msg) {
  const el = document.getElementById('auth-err');
  el.textContent = msg;
  el.classList.add('show');
}
function clearAuthErr() {
  document.getElementById('auth-err').classList.remove('show');
}

// ── 데모 계정 로그인 (DB 없이도 체험) ──────────────────
const DEMO_USERS = {
  'guardian@caring.kr': { password: 'caring1234', role: 'guardian', name: '김보호', email: 'guardian@caring.kr', id: 'demo-guardian' },
  'elder@caring.kr':    { password: 'caring1234', role: 'elder',    name: '이어르신', email: 'elder@caring.kr',  id: 'demo-elder' },
  'admin@caring.kr':    { password: 'caring1234', role: 'admin',    name: '관리자',  email: 'admin@caring.kr',  id: 'demo-admin' },
};

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw    = document.getElementById('login-pw').value;
  if (!email || !pw) { showAuthErr('이메일과 비밀번호를 입력해주세요.'); return; }

  // 데모 계정 체크
  const demo = DEMO_USERS[email];
  if (demo && demo.password === pw) {
    currentUser = { token: 'demo-token-' + demo.role, ...demo };
    saveUser();
    showApp(demo.role);
    return;
  }

  // 실제 API 로그인 시도
  try {
    const res = await fetch(API + '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw }),
    });
    if (res.ok) {
      const d = await res.json();
      // API 응답: { data: { user, accessToken, refreshToken } }
      const userData = d.data || d;
      const user = userData.user || d.user;
      const token = userData.accessToken || userData.access_token || d.access_token || '';
      if (!user || !token) throw new Error('로그인 응답이 올바르지 않습니다.');
      currentUser = {
        token,
        role: user.role,
        name: user.display_name,
        email: user.email,
        id: user.id,
      };
      saveUser();
      showApp(currentUser.role);
    } else {
      const err = await res.json();
      showAuthErr(err.message || '이메일 또는 비밀번호가 올바르지 않습니다.');
    }
  } catch (e) {
    showAuthErr('서버 연결 오류. 데모 계정을 사용해주세요.');
  }
}

async function doRegister() {
  const name  = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pw    = document.getElementById('reg-pw').value;
  const role  = document.querySelector('.role-btn.sel')?.dataset.role || 'guardian';

  if (!name || !email || !pw) { showAuthErr('모든 항목을 입력해주세요.'); return; }
  if (pw.length < 8 || !/\d/.test(pw)) { showAuthErr('비밀번호는 8자 이상, 숫자 포함이어야 합니다.'); return; }

  try {
    const res = await fetch(API + '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: name, email, password: pw, role }),
    });
    const d = await res.json();
    if (res.ok || res.status === 201) {
      // 회원가입 성공 - 자동 로그인 시도
      const userData = d.data || d;
      const user = userData.user || d.user;
      const token = userData.accessToken || userData.access_token || '';
      if (user && token) {
        currentUser = { token, role: user.role, name: user.display_name, email: user.email, id: user.id };
        saveUser();
        showToast('✅ 가입 완료! 환영합니다 😊');
        showApp(currentUser.role);
      } else {
        showToast('✅ 가입 완료! 로그인해주세요.');
        document.getElementById('tab-login').click();
        document.getElementById('login-email').value = email;
      }
    } else {
      const msg = d.message || d.errors?.[0]?.msg || '가입 중 오류가 발생했습니다.';
      showAuthErr(msg);
    }
  } catch (e) {
    showAuthErr('서버 연결 오류. 잠시 후 다시 시도해주세요.');
  }
}

function doLogout(role) {
  localStorage.removeItem('caring_user');
  currentUser = null;
  hideAllApps();
  document.getElementById('auth-screen').style.display = 'flex';
  showToast('로그아웃 되었습니다.');
}

// ── 앱 화면 전환 ──────────────────────────────────────
function hideAllApps() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('guardian-app').style.display = 'none';
  document.getElementById('elder-app').style.display = 'none';
  document.getElementById('admin-app').style.display = 'none';
}

function showApp(role) {
  hideAllApps();
  requestNotifPermission();
  if (role === 'guardian') {
    document.getElementById('guardian-app').style.display = 'block';
    initGuardianApp();
  } else if (role === 'elder') {
    document.getElementById('elder-app').style.display = 'block';
    initElderApp();
  } else if (role === 'admin') {
    document.getElementById('admin-app').style.display = 'block';
    initAdminApp();
  }
}

// ── 탭 전환 공통 ──────────────────────────────────────
function setupTabs(appEl) {
  appEl.querySelectorAll('.tab[data-page]').forEach(btn => {
    btn.addEventListener('click', function() {
      appEl.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
      appEl.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
      this.classList.add('on');
      const pg = appEl.querySelector('#' + this.dataset.page);
      if (pg) pg.classList.add('on');
    });
  });
}

// ── 서버 상태 공통 ────────────────────────────────────
async function checkServer(srvEl, dbEl, redisEl) {
  try {
    const res = await fetch('/health', { signal: AbortSignal.timeout(5000) });
    const d = await res.json();
    if (srvEl) { srvEl.textContent = '✓ 정상'; srvEl.className = 'srv-ok'; }
    if (dbEl)  { dbEl.textContent = d.db === 'ok' ? '✓ 연결됨' : '✗ 오류'; dbEl.className = d.db === 'ok' ? 'srv-ok' : 'srv-err'; }
    if (redisEl){ redisEl.textContent = d.redis === 'ok' ? '✓ 연결됨' : '✗ 오류'; redisEl.className = d.redis === 'ok' ? 'srv-ok' : 'srv-err'; }
  } catch {
    if (srvEl) { srvEl.textContent = '✗ 오류'; srvEl.className = 'srv-err'; }
  }
}

// ── 복약 렌더링 ──────────────────────────────────────
function renderMeds(listId, checkable = true) {
  const list = document.getElementById(listId);
  if (!list) return;
  if (!meds.length) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--t3)">등록된 복약 없음</div>';
    return;
  }
  list.innerHTML = meds.map((m, idx) => {
    const done = medChecks.includes(idx);
    return `<div class="med-item">
      <div class="med-icon">${m.icon || '💊'}</div>
      <div class="med-info">
        <div class="med-name">${m.name}</div>
        <div class="med-time">⏰ ${m.time} — <span style="color:${done ? 'var(--s)' : 'var(--wn)'}">${done ? '✓ 완료' : '대기 중'}</span></div>
      </div>
      ${checkable ? `<button class="med-chk ${done ? 'done' : ''}" data-idx="${idx}" ${done ? 'disabled' : ''}>${done ? '✓' : ''}</button>` : ''}
    </div>`;
  }).join('');

  if (checkable) {
    list.querySelectorAll('[data-idx]').forEach(btn => {
      btn.addEventListener('click', function() {
        const idx = +this.dataset.idx;
        if (!medChecks.includes(idx)) {
          medChecks.push(idx);
          saveChecks();
          renderMeds(listId, true);
          showToast('💊 복약 완료! 건강하세요 😊');
        }
      });
    });
  }

  // 복약 상태 요약 업데이트
  const done = medChecks.length, total = meds.length;
  const medStatusEl = document.getElementById('g-med-status');
  if (medStatusEl) {
    medStatusEl.textContent = `${done}/${total} 완료`;
    medStatusEl.style.color = done === total ? 'var(--s)' : 'var(--wn)';
  }
}

// ── 보호자 앱 초기화 ──────────────────────────────────
function initGuardianApp() {
  const app = document.getElementById('guardian-app');
  setupTabs(app);

  document.getElementById('g-hdr-sub').textContent = `${currentUser.name}님, 안녕하세요`;
  document.getElementById('g-my-name').textContent = currentUser.name;
  document.getElementById('g-my-email').textContent = currentUser.email;

  // 부모님 정보 (localStorage)
  const elderInfo = JSON.parse(localStorage.getItem('caring_linked_elder') || 'null');
  if (elderInfo) {
    document.getElementById('g-elder-name').textContent = elderInfo.name;
    document.getElementById('g-elder-status').textContent = '연결됨 · 마지막 확인: 방금';
  }

  // 마지막 안부 메시지 표시 (localStorage 폴링)
  function renderLastWellbeing() {
    const wb = JSON.parse(localStorage.getItem('caring_last_wellbeing') || 'null');
    let wbEl = document.getElementById('g-wellbeing-banner');
    if (!wb) { if (wbEl) wbEl.remove(); return; }
    const timeStr = new Date(wb.time).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (!wbEl) {
      wbEl = document.createElement('div');
      wbEl.id = 'g-wellbeing-banner';
      wbEl.className = 'card';
      wbEl.style.cssText = 'background:linear-gradient(135deg,#f0fdf4,#dcfce7);border-color:#bbf7d0';
      const homeCard = document.querySelector('#g-home .card');
      homeCard.parentNode.insertBefore(wbEl, homeCard.nextSibling);
    }
    wbEl.innerHTML = `<div class="card-title">💌 마지막 안부</div>
      <div style="font-size:1rem;font-weight:700;color:#15803d;margin-bottom:4px">${wb.text}</div>
      <div style="font-size:.78rem;color:#64748b">${wb.sender || '어르신'} · ${timeStr}</div>`;
  }
  renderLastWellbeing();
  // 30초마다 폴링 (localStorage 기반 시뮬레이션)
  setInterval(renderLastWellbeing, 30000);

  // GPS 최근 위치 표시
  showLastLocation();
  setInterval(showLastLocation, 300000);

  renderMeds('g-med-list', true);
  checkServer(
    document.getElementById('g-srv-status'),
    document.getElementById('g-db-status'),
    document.getElementById('g-redis-status')
  );
  setInterval(() => checkServer(
    document.getElementById('g-srv-status'),
    document.getElementById('g-db-status'),
    document.getElementById('g-redis-status')
  ), 30000);

  // 이벤트
  document.getElementById('g-logout').addEventListener('click', () => doLogout('guardian'));
  document.getElementById('g-btn-call').addEventListener('click', () => showToast('📞 전화번호를 등록해주세요.'));
  document.getElementById('g-btn-msg').addEventListener('click', () => document.getElementById('g-msg-form').classList.toggle('open'));
  document.getElementById('g-btn-cancel-msg').addEventListener('click', () => document.getElementById('g-msg-form').classList.remove('open'));
  document.getElementById('g-btn-send-msg').addEventListener('click', () => {
    const txt = document.getElementById('g-msg-text').value.trim();
    if (!txt) { showToast('메시지를 입력해주세요'); return; }
    showToast('💬 안부 메시지 전송 완료! (데모)');
    document.getElementById('g-msg-text').value = '';
    document.getElementById('g-msg-form').classList.remove('open');
  });
  // ── 위치 확인 → 수동 위치 등록 ───────────────────────
  document.getElementById('g-btn-loc').addEventListener('click', () => {
    const lastLoc = JSON.parse(localStorage.getItem('caring_location_last') || 'null');
    const homeAddr = localStorage.getItem('caring_home_address') || '';
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:flex-end;justify-content:center';
    const locTimeStr = lastLoc ? new Date(lastLoc.time).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    modal.innerHTML = `<div style="background:#fff;border-radius:20px 20px 0 0;padding:24px;width:100%;max-width:480px">
      <div style="font-size:1.1rem;font-weight:700;margin-bottom:12px">📍 위치 확인</div>
      <div style="display:flex;gap:0;background:#f0f9ff;border-radius:10px;padding:4px;margin-bottom:16px">
        <button id="loc-tab-cur" onclick="caringLocTab('cur')" style="flex:1;padding:8px;border:none;border-radius:8px;background:#fff;font-weight:700;color:#0ea5e9;cursor:pointer;font-family:inherit">현재 위치</button>
        <button id="loc-tab-zone" onclick="caringLocTab('zone')" style="flex:1;padding:8px;border:none;background:none;font-weight:600;color:#64748b;cursor:pointer;font-family:inherit">안전구역 등록</button>
      </div>
      <div id="loc-cur">
        ${lastLoc
          ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;margin-bottom:12px">
               <div style="font-size:.78rem;color:#64748b;margin-bottom:4px">📅 마지막 위치 전송: ${locTimeStr}</div>
               <div style="font-size:1rem;font-weight:700;color:#15803d">📍 ${lastLoc.address}</div>
             </div>`
          : `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;padding:14px;margin-bottom:12px;font-size:.875rem;color:#92400e">
               부모님이 아직 위치를 보내지 않으셨어요.<br>어르신 앱의 <b>'안부 보내기'</b> 버튼을 눌러달라고 하세요.
             </div>`}
      </div>
      <div id="loc-zone" style="display:none">
        <div style="font-size:.85rem;color:#64748b;margin-bottom:8px">집 주소를 등록하면 홈 화면에 '안전구역'으로 표시됩니다.</div>
        <input id="loc-addr-input" type="text" placeholder="예: 서울시 강남구 역삼동 ..." value="${homeAddr.replace(/"/g,'&quot;')}"
          style="width:100%;padding:12px;border:1.5px solid #bae6fd;border-radius:10px;font-size:.95rem;font-family:inherit;outline:none;margin-bottom:12px;box-sizing:border-box">
        <button onclick="caringLocSave()" style="width:100%;padding:12px;background:#22c55e;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit">✅ 안전구역 등록</button>
      </div>
      <button onclick="this.closest('[style*=fixed]').remove()" style="width:100%;padding:10px;background:none;border:1.5px solid #bae6fd;border-radius:10px;font-size:.9rem;font-weight:600;cursor:pointer;margin-top:8px;color:#64748b;font-family:inherit">닫기</button>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    window.caringLocTab = function(tab) {
      document.getElementById('loc-cur').style.display = tab === 'cur' ? '' : 'none';
      document.getElementById('loc-zone').style.display = tab === 'zone' ? '' : 'none';
      const sel = 'flex:1;padding:8px;border:none;border-radius:8px;background:#fff;font-weight:700;color:#0ea5e9;cursor:pointer;font-family:inherit';
      const unsel = 'flex:1;padding:8px;border:none;background:none;font-weight:600;color:#64748b;cursor:pointer;font-family:inherit';
      document.getElementById('loc-tab-cur').style.cssText = tab === 'cur' ? sel : unsel;
      document.getElementById('loc-tab-zone').style.cssText = tab === 'zone' ? sel : unsel;
    };
    window.caringLocSave = function() {
      const addr = document.getElementById('loc-addr-input').value.trim();
      if (!addr) { showToast('주소를 입력해주세요'); return; }
      localStorage.setItem('caring_home_address', addr);
      showToast('✅ 안전구역이 등록되었습니다!');
      document.querySelector('[style*="position:fixed"]').remove();
    };
  });

  // ── 보호자 초대 코드 시스템 ──────────────────────────
  document.getElementById('g-btn-family').addEventListener('click', () => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + 24 * 60 * 60 * 1000;
    localStorage.setItem('caring_invite_code', JSON.stringify({ code, expiry }));
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:flex-end;justify-content:center';
    modal.innerHTML = `<div style="background:#fff;border-radius:20px 20px 0 0;padding:24px;width:100%;max-width:480px">
      <div style="font-size:1.1rem;font-weight:700;margin-bottom:12px">👨‍👩‍👧 보호자 추가</div>
      <div style="display:flex;gap:0;background:#f0f9ff;border-radius:10px;padding:4px;margin-bottom:16px">
        <button id="inv-tab-gen" onclick="caringInvTab('gen')" style="flex:1;padding:8px;border:none;border-radius:8px;background:#fff;font-weight:700;color:#0ea5e9;cursor:pointer;font-family:inherit">코드 생성</button>
        <button id="inv-tab-inp" onclick="caringInvTab('inp')" style="flex:1;padding:8px;border:none;background:none;font-weight:600;color:#64748b;cursor:pointer;font-family:inherit">코드 입력</button>
      </div>
      <div id="inv-gen">
        <div style="text-align:center;padding:20px;background:#f0f9ff;border-radius:14px;margin-bottom:12px">
          <div style="font-size:.78rem;color:#64748b;margin-bottom:8px">초대 코드 (24시간 유효)</div>
          <div style="font-size:2.8rem;font-weight:700;letter-spacing:.25em;color:#0ea5e9;font-feature-settings:'tnum'">${code}</div>
          <div style="font-size:.78rem;color:#94a3b8;margin-top:8px">이 코드를 보호자에게 공유하세요</div>
        </div>
        <button onclick="caringCopyCode('${code}')" style="width:100%;padding:12px;background:#0ea5e9;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:0">📋 코드 복사하기</button>
      </div>
      <div id="inv-inp" style="display:none">
        <div style="font-size:.85rem;color:#64748b;margin-bottom:8px">받은 6자리 코드를 입력하세요.</div>
        <input id="inv-code-input" type="text" maxlength="6" placeholder="6자리 코드"
          style="width:100%;padding:14px;border:1.5px solid #bae6fd;border-radius:10px;font-size:1.5rem;letter-spacing:.3em;text-align:center;font-family:inherit;outline:none;margin-bottom:12px;box-sizing:border-box">
        <button onclick="caringConnectCode()" style="width:100%;padding:12px;background:#22c55e;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit">🔗 연결하기</button>
      </div>
      <button onclick="this.closest('[style*=fixed]').remove()" style="width:100%;padding:10px;background:none;border:1.5px solid #bae6fd;border-radius:10px;font-size:.9rem;font-weight:600;cursor:pointer;margin-top:8px;color:#64748b;font-family:inherit">닫기</button>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    window.caringInvTab = function(tab) {
      document.getElementById('inv-gen').style.display = tab === 'gen' ? '' : 'none';
      document.getElementById('inv-inp').style.display = tab === 'inp' ? '' : 'none';
      const sel = 'flex:1;padding:8px;border:none;border-radius:8px;background:#fff;font-weight:700;color:#0ea5e9;cursor:pointer;font-family:inherit';
      const unsel = 'flex:1;padding:8px;border:none;background:none;font-weight:600;color:#64748b;cursor:pointer;font-family:inherit';
      document.getElementById('inv-tab-gen').style.cssText = tab === 'gen' ? sel : unsel;
      document.getElementById('inv-tab-inp').style.cssText = tab === 'inp' ? sel : unsel;
    };
    window.caringCopyCode = function(c) {
      navigator.clipboard.writeText(c)
        .then(() => showToast('✅ 코드가 복사되었습니다!'))
        .catch(() => showToast('코드: ' + c));
    };
    window.caringConnectCode = function() {
      const input = (document.getElementById('inv-code-input').value || '').trim();
      if (input.length !== 6) { showToast('6자리 코드를 입력해주세요'); return; }
      const stored = JSON.parse(localStorage.getItem('caring_invite_code') || 'null');
      if (stored && stored.code === input && Date.now() < stored.expiry) {
        const elderData = JSON.parse(localStorage.getItem('caring_linked_elder') || '{}');
        localStorage.setItem('caring_linked_elder', JSON.stringify({
          name: elderData.name || '연결된 어르신', id: 'elder-' + input, code: input
        }));
        showToast('✅ 보호자 연결 완료!', 3000);
        document.querySelector('[style*="position:fixed"]').remove();
        initGuardianApp();
      } else {
        showToast('❌ 코드가 올바르지 않거나 만료되었습니다');
      }
    };
  });

  // 복약 추가
  document.getElementById('g-btn-add-med').addEventListener('click', () => {
    const name = prompt('약 이름을 입력하세요:');
    if (!name) return;
    const time = prompt('복용 시간 (예: 아침 8시):') || '아침 8시';
    meds.push({ id: Date.now(), name, time, icon: '💊' });
    saveMeds();
    renderMeds('g-med-list', true);
    scheduleMedAlerts();
    showToast('💊 복약 추가 완료!');
  });
}

// ── 케어 대상자 앱 초기화 ────────────────────────────
function initElderApp() {
  const app = document.getElementById('elder-app');
  setupTabs(app);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? '좋은 아침이에요! 🌅' : hour < 18 ? '좋은 오후예요! ☀️' : '좋은 저녁이에요! 🌙';
  document.getElementById('e-greeting').textContent = `${currentUser.name}님, ${greeting}`;
  document.getElementById('e-hdr-sub').textContent = '오늘도 건강한 하루 되세요 😊';

  renderMeds('e-med-list', true);
  // 복약 알림 스케줄 등록
  scheduleMedAlerts();

  // 복약 요약
  const done = medChecks.length, total = meds.length;
  const iconEl = document.getElementById('e-med-icon');
  const txtEl  = document.getElementById('e-med-txt');
  if (total === 0) {
    iconEl.textContent = '📋'; txtEl.textContent = '등록된 복약이 없어요';
  } else if (done === total) {
    iconEl.textContent = '✅'; txtEl.textContent = `오늘 복약 완료! (${done}/${total})`;
    txtEl.style.color = 'var(--s)';
  } else {
    iconEl.textContent = '⏳'; txtEl.textContent = `${done}/${total} 완료 · ${total - done}개 남았어요`;
    txtEl.style.color = 'var(--wn)';
  }

  document.getElementById('e-logout').addEventListener('click', () => doLogout('elder'));
  document.getElementById('e-btn-family-call').addEventListener('click', () => showToast('📞 가족 전화번호를 등록해주세요.'));

  // GPS 위치 공유
  document.getElementById('e-loc-btn').addEventListener('click', requestLocation);

  // SOS
  document.getElementById('e-sos-btn').addEventListener('click', () => {
    if (confirm('⚠️ 가족에게 응급 알림을 보내시겠어요?')) {
      caringNotify('🛑 응급 상황!', currentUser.name + '님이 SOS를 누르셨습니다. 지금 바로 확인해주세요!');
      showToast('🆘 가족에게 응급 알림을 보냈습니다!', 3500);
    }
  });

  // 안부 메시지 빠른 전송 (localStorage 저장 → 보호자 화면 폴링)
  document.querySelectorAll('#e-home [data-msg]').forEach(btn => {
    btn.addEventListener('click', function() {
      const msg = this.dataset.msg;
      const record = { text: msg, time: Date.now(), sender: currentUser.name };
      localStorage.setItem('caring_last_wellbeing', JSON.stringify(record));
      // localStorage에 안부 메시지 저장 (보호자 알림용)
      localStorage.setItem('caring_last_msg', JSON.stringify({ text: msg, time: Date.now(), from: currentUser.name }));
      // 웹 알림 (같은 브라우저 창이 여러 개인 경우 포함)
      caringNotify('💗 ' + currentUser.name + '님의 안부 메시지', msg);
      // 위치 정보도 같이 저장 (안부 = 위치 전송 시뮬레이션)
      const homeAddr = localStorage.getItem('caring_home_address');
      if (homeAddr) {
        localStorage.setItem('caring_location_last', JSON.stringify({ address: homeAddr, time: Date.now() }));
      }
      showToast(`💌 "${msg}" 전송 완료!`, 3000);
    });
  });

  // 건강 상태
  document.querySelectorAll('.hb[data-status]').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.hb').forEach(b => b.classList.remove('sel'));
      this.classList.add('sel');
    });
  });
  document.getElementById('e-submit-health').addEventListener('click', () => {
    const sel = document.querySelector('.hb.sel');
    if (!sel) { showToast('건강 상태를 선택해주세요'); return; }
    showToast('❤️ 건강 상태가 전송되었습니다! (데모)');
  });
}

// ── 관리자 앱 초기화 ──────────────────────────────────
async function initAdminApp() {
  const app = document.getElementById('admin-app');
  setupTabs(app);

  document.getElementById('a-logout').addEventListener('click', () => doLogout('admin'));
  document.getElementById('a-refresh-srv').addEventListener('click', () => checkServer(
    document.getElementById('a-srv-ping'),
    document.getElementById('a-db-status'),
    document.getElementById('a-redis-status')
  ));

  checkServer(
    document.getElementById('a-srv-ping'),
    document.getElementById('a-db-status'),
    document.getElementById('a-redis-status')
  );

  // 사용자 목록 로드
  await loadAdminUsers();
}

async function loadAdminUsers() {
  if (isDemoSession(currentUser)) {
    renderAdminUsersViewModel(buildAdminUsersViewModel({
      mode: 'demo',
      message: '데모 관리자 계정은 서버 인증이 없어 실사용자 목록을 조회할 수 없습니다.',
    }));
    return;
  }

  try {
    const res = await fetch('/api/v1/users', {
      headers: { 'Authorization': 'Bearer ' + (currentUser?.token || '') }
    });
    const payload = await readJsonSafe(res);
    if (!res.ok) {
      renderAdminUsersViewModel(buildAdminUsersViewModel({
        mode: 'error',
        status: res.status,
        error: payload?.error,
        message: payload?.message || `관리자 API가 ${res.status} 응답을 반환했습니다.`,
      }));
      return;
    }

    const users = normalizeAdminUsersPayload(payload);
    if (!users) {
      renderAdminUsersViewModel(buildAdminUsersViewModel({
        mode: 'error',
        message: '관리자 사용자 목록 응답 형식이 올바르지 않습니다.',
      }));
      return;
    }

    renderAdminUsersViewModel(buildAdminUsersViewModel({
      mode: 'ready',
      users,
    }));
  } catch {
    renderAdminUsersViewModel(buildAdminUsersViewModel({
      mode: 'error',
      message: '네트워크 오류로 관리자 데이터를 불러오지 못했습니다.',
    }));
  }
}

// ── 회원가입 역할 선택 ────────────────────────────────
function setupRoleBtns() {
  document.querySelectorAll('.role-btn[data-role]').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('sel'));
      this.classList.add('sel');
    });
  });
}

// ── GPS 위치 추적 ──────────────────────────────────────
function requestLocation() {
  if (!navigator.geolocation) {
    showToast('이 기기는 위치 서비스를 지원하지 않아요');
    return;
  }
  showToast('📡 위치 정보를 가져오는 중...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude.toFixed(5);
      const lon = pos.coords.longitude.toFixed(5);
      const acc = Math.round(pos.coords.accuracy);
      const locData = { lat, lon, acc, time: Date.now() };
      localStorage.setItem('caring_location', JSON.stringify(locData));
      showToast(`📍 위치 공유 완료 (정확도 ${acc}m)`);
      caringNotify('📍 위치 공유', `어르신의 현재 위치가 업데이트되었습니다 (정확도 ${acc}m)`);
      const el = document.getElementById('elder-location-display');
      if (el) el.textContent = `위도 ${lat}, 경도 ${lon} (오차 ${acc}m)`;
    },
    (err) => {
      const msgs = {
        1: '위치 권한이 거부되었어요. 브라우저 설정에서 허용해주세요.',
        2: '위치 정보를 가져오지 못했어요.',
        3: '위치 요청 시간이 초과되었어요.',
      };
      showToast(msgs[err.code] || '위치 오류');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function showLastLocation() {
  const raw = localStorage.getItem('caring_location');
  if (!raw) return;
  try {
    const loc = JSON.parse(raw);
    const mins = Math.round((Date.now() - loc.time) / 60000);
    const el = document.getElementById('guardian-location-info');
    if (el) {
      el.innerHTML = `📍 최근 GPS 위치: ${loc.lat}, ${loc.lon} (오차 ${loc.acc}m, ${mins}분 전)`;
      el.style.display = 'block';
    }
  } catch(e) {}
}

async function restorePersistedSession() {
  if (!(currentUser && currentUser.token)) return;

  const result = await revalidateStoredSession(currentUser);
  if (!result.ok) {
    localStorage.removeItem('caring_user');
    currentUser = null;
    showAuthErr(result.message || '저장된 세션이 만료되어 다시 로그인해주세요.');
    return;
  }

  currentUser = result.user;
  saveUser();
  showApp(currentUser.role);
}

// ── 부트 ──────────────────────────────────────────────
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async function() {
    loadData();
    setupAuthTabs();
    setupRoleBtns();

    // 로그인 버튼
    document.getElementById('login-btn').addEventListener('click', doLogin);
    document.getElementById('register-btn').addEventListener('click', doRegister);
    document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-pw').focus(); });
    document.getElementById('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

    await restorePersistedSession();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildAdminUsersViewModel,
    isDemoSession,
    normalizeAdminUsersPayload,
    revalidateStoredSession,
  };
}
