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

function loadData() {
  const raw = localStorage.getItem('caring_user');
  if (raw) currentUser = JSON.parse(raw);
  meds = JSON.parse(localStorage.getItem('caring_meds') || '[]');
  medChecks = JSON.parse(localStorage.getItem('caring_checks_' + TODAY) || '[]');
}

function saveUser() { localStorage.setItem('caring_user', JSON.stringify(currentUser)); }
function saveMeds() { localStorage.setItem('caring_meds', JSON.stringify(meds)); }
function saveChecks() { localStorage.setItem('caring_checks_' + TODAY, JSON.stringify(medChecks)); }

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
  document.getElementById('g-btn-loc').addEventListener('click', () => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:flex-end;justify-content:center';
    modal.innerHTML = `<div style="background:#fff;border-radius:20px 20px 0 0;padding:24px;width:100%;max-width:480px">
      <div style="font-size:1.1rem;font-weight:700;margin-bottom:12px">📍 위치 확인</div>
      <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;padding:14px;font-size:.875rem;color:#92400e;margin-bottom:16px">
        <div style="font-weight:700;margin-bottom:6px">⚠️ 이 기능은 아직 준비 중입니다</div>
        <div>실시간 위치 추적은 아래 조건이 필요합니다:<br>
        ① PostgreSQL DB 연결<br>
        ② 부모님 기기에 케어링 앱 설치 및 위치 권한 허용<br>
        ③ GPS 모듈 연동</div>
      </div>
      <button onclick="this.closest('[style*=fixed]').remove()" style="width:100%;padding:12px;background:#0ea5e9;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer">확인</button>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  });
  document.getElementById('g-btn-family').addEventListener('click', () => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:flex-end;justify-content:center';
    modal.innerHTML = `<div style="background:#fff;border-radius:20px 20px 0 0;padding:24px;width:100%;max-width:480px">
      <div style="font-size:1.1rem;font-weight:700;margin-bottom:12px">👨‍👩‍👧 보호자 추가</div>
      <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;padding:14px;font-size:.875rem;color:#92400e;margin-bottom:16px">
        <div style="font-weight:700;margin-bottom:6px">⚠️ 이 기능은 아직 준비 중입니다</div>
        <div>보호자 네트워크 기능은 아래 조건이 필요합니다:<br>
        ① PostgreSQL DB 연결<br>
        ② 추가할 보호자가 케어링 계정 보유<br>
        ③ 초대 링크 발송 기능 (이메일/SMS)</div>
      </div>
      <button onclick="this.closest('[style*=fixed]').remove()" style="width:100%;padding:12px;background:#0ea5e9;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer">확인</button>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  });

  // 복약 추가
  document.getElementById('g-btn-add-med').addEventListener('click', () => {
    const name = prompt('약 이름을 입력하세요:');
    if (!name) return;
    const time = prompt('복용 시간 (예: 아침 8시):') || '아침 8시';
    meds.push({ id: Date.now(), name, time, icon: '💊' });
    saveMeds();
    renderMeds('g-med-list', true);
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

  // SOS
  document.getElementById('e-sos-btn').addEventListener('click', () => {
    if (confirm('⚠️ 가족에게 응급 알림을 보내시겠어요?')) {
      showToast('🆘 가족에게 응급 알림을 보냈습니다!', 3500);
    }
  });

  // 안부 메시지 빠른 전송
  document.querySelectorAll('#e-home [data-msg]').forEach(btn => {
    btn.addEventListener('click', function() {
      showToast(`💌 "${this.dataset.msg}" 전송 완료! (데모)`);
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
  const tbody = document.getElementById('a-user-table-body');
  try {
    const res = await fetch('/api/v1/users', {
      headers: { 'Authorization': 'Bearer ' + (currentUser?.token || '') }
    });
    if (res.ok) {
      const users = await res.json();
      const guardians = users.filter(u => u.role === 'guardian').length;
      const elders    = users.filter(u => u.role === 'elder').length;
      document.getElementById('a-total-users').textContent = users.length;
      document.getElementById('a-guardian-count').textContent = guardians;
      document.getElementById('a-elder-count').textContent = elders;
      tbody.innerHTML = users.map(u => `<tr>
        <td>${u.display_name}</td>
        <td style="color:var(--t3)">${u.email}</td>
        <td><span class="role-tag ${u.role}">${u.role === 'guardian' ? '보호자' : '어르신'}</span></td>
        <td style="color:var(--t3);font-size:.75rem">${u.created_at ? u.created_at.slice(0,10) : '—'}</td>
      </tr>`).join('');
    } else {
      // 데모 데이터
      document.getElementById('a-total-users').textContent = '3';
      document.getElementById('a-guardian-count').textContent = '2';
      document.getElementById('a-elder-count').textContent = '1';
      tbody.innerHTML = `
        <tr><td>김보호</td><td style="color:var(--t3)">guardian@caring.kr</td><td><span class="role-tag guardian">보호자</span></td><td style="color:var(--t3);font-size:.75rem">2026-01-01</td></tr>
        <tr><td>이어르신</td><td style="color:var(--t3)">elder@caring.kr</td><td><span class="role-tag elder">어르신</span></td><td style="color:var(--t3);font-size:.75rem">2026-01-02</td></tr>
      `;
    }
  } catch {
    // 데모 데이터 표시
    document.getElementById('a-total-users').textContent = '데모';
    document.getElementById('a-guardian-count').textContent = '1';
    document.getElementById('a-elder-count').textContent = '1';
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:12px;color:var(--t3)">데모 모드 — DB 연결 후 실제 데이터 표시</td></tr>';
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

// ── 부트 ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  loadData();
  setupAuthTabs();
  setupRoleBtns();

  // 로그인 버튼
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('register-btn').addEventListener('click', doRegister);
  document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-pw').focus(); });
  document.getElementById('login-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  // 자동 로그인 (토큰 유지)
  if (currentUser && currentUser.token) {
    showApp(currentUser.role);
  }
});
