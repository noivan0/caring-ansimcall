// ── 상수 ──────────────────────────────────────
var STORE_KEY = 'caring_v2';
var API = '';
var ICONS = ['🔴','🟡','🔵','🟢','🟠','🟣'];

// ── 상태 ──────────────────────────────────────
var S = { name:'', phone:'010-0000-0000', meds:[], medsDone:{}, lastCheck:null, lastCall:null, done:false };
var obMeds = [];

// ── 저장/로드 ──────────────────────────────────
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch(e){} }
function load() { try { var r=localStorage.getItem(STORE_KEY); if(r) S=Object.assign(S,JSON.parse(r)); } catch(e){} }
function todayKey() { return new Date().toISOString().slice(0,10); }

// ── 토스트 ────────────────────────────────────
var _toastTimer;
function showToast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' '+type : '');
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2800);
}

// ── 전화번호 포맷 ──────────────────────────────
function formatPhone(el) {
  var v = el.value.replace(/\D/g,'');
  if (v.length > 3 && v.length <= 7) v = v.slice(0,3)+'-'+v.slice(3);
  else if (v.length > 7) v = v.slice(0,3)+'-'+v.slice(3,7)+'-'+v.slice(7,11);
  el.value = v;
}

// ── 온보딩 ──────────────────────────────────────
function obSetStep(n) {
  document.querySelectorAll('.ob-step').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('ob-'+n).classList.add('active');
  for (var i=1;i<=4;i++) document.getElementById('ob-p'+i).classList.toggle('done', i<=n);
}
function obRenderMeds() {
  var el = document.getElementById('ob-med-list');
  if (!obMeds.length) { el.innerHTML=''; return; }
  el.innerHTML = obMeds.map(function(m,i){
    return '<div class="ob-med-item"><span>'+ICONS[i%ICONS.length]+' '+esc(m.name)+
           ' <span style="color:var(--text-3);font-size:.8rem">('+m.time+')</span></span>'+
           '<button class="ob-med-remove" data-idx="'+i+'">✕</button></div>';
  }).join('');
  el.querySelectorAll('.ob-med-remove').forEach(function(btn){
    btn.addEventListener('click',function(){ obMeds.splice(+btn.dataset.idx,1); obRenderMeds(); });
  });
}

// ── 메인 앱 ───────────────────────────────────
function initMain() {
  document.getElementById('parent-name').textContent = S.name || '부모님';
  var ph = S.phone || '010-0000-0000';
  document.getElementById('btn-call').href = 'tel:' + ph;
  renderLastCheck();
  renderLastCall();
  renderMeds();
  renderMedStatus();
  renderLocalData();
  checkServer();
  startPolling();
}

// ── 탭 ───────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(function(el){ el.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(el){ el.classList.remove('active'); });
  document.getElementById('tab-'+name).classList.add('active');
  if (btn) btn.classList.add('active');
  if (name === 'system') { checkServer(); renderLocalData(); }
}
function goToSystemTab() {
  if (document.getElementById('main-app').style.display === 'none') return;
  var btn = document.getElementById('tab-btn-system');
  switchTab('system', btn);
}

// ── 시간 ──────────────────────────────────────
function renderLastCheck() {
  var el = document.getElementById('last-check-text');
  if (!el) return;
  if (!S.lastCheck) { el.textContent='아직 없음'; return; }
  el.textContent = relTime(S.lastCheck);
}
function renderLastCall() {
  var v = document.getElementById('last-call-val');
  var s = document.getElementById('last-call-sub');
  if (!v||!s) return;
  if (!S.lastCall) { v.textContent='—'; s.textContent='아직 없음'; return; }
  var d = new Date(S.lastCall);
  v.textContent = relTime(S.lastCall);
  s.textContent = d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
}
function relTime(iso) {
  var diff = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diff < 1) return '방금 전';
  if (diff < 60) return diff+'분 전';
  if (diff < 1440) return Math.floor(diff/60)+'시간 전';
  return Math.floor(diff/1440)+'일 전';
}

// ── 복약 ──────────────────────────────────────
function renderMeds() {
  var list = document.getElementById('med-list');
  if (!list) return;
  if (!S.meds || !S.meds.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:20px">복약 일정이 없습니다<br><small>아래에서 추가하세요</small></div>';
    return;
  }
  var today = todayKey();
  var done = (S.medsDone && S.medsDone[today]) || {};
  list.innerHTML = S.meds.map(function(m,i){
    var isDone = !!done[i];
    var elapsed = isElapsed(m.time);
    var color = isDone ? 'var(--success)' : (elapsed ? 'var(--warning)' : 'var(--text-3)');
    var txt = isDone ? '✓ 복약 완료' : (elapsed ? '⏳ 미복약' : '— 예정');
    return '<div class="med-item'+(isDone?' done-item':'')+'">'+
      '<div class="med-icon">'+(m.icon||'💊')+'</div>'+
      '<div class="med-info">'+
        '<div class="med-name">'+esc(m.name)+'</div>'+
        '<div class="med-time">⏰ '+m.time+' — <span style="color:'+color+'">'+txt+'</span></div>'+
      '</div>'+
      '<button class="med-check'+(isDone?' done':'')+ '" data-idx="'+i+'" title="'+(isDone?'취소':'완료')+'"></button>'+
    '</div>';
  }).join('');
  list.querySelectorAll('.med-check').forEach(function(btn){
    btn.addEventListener('click',function(){
      var idx = +btn.dataset.idx;
      var today2 = todayKey();
      if (!S.medsDone) S.medsDone = {};
      if (!S.medsDone[today2]) S.medsDone[today2] = {};
      var wasDone = !!S.medsDone[today2][idx];
      S.medsDone[today2][idx] = !wasDone;
      save();
      renderMeds();
      renderMedStatus();
      showToast(wasDone ? '↩️ 복약 기록 취소' : '💊 복약을 기록했습니다!', wasDone ? '' : 'success');
    });
  });
}
function renderMedStatus() {
  var ms = document.getElementById('med-status');
  var mr = document.getElementById('med-remain');
  if (!S.meds || !S.meds.length) {
    if(ms) ms.textContent='없음'; if(mr) mr.textContent='복약 탭에서 추가'; return;
  }
  var today = todayKey();
  var done = (S.medsDone && S.medsDone[today]) || {};
  var doneCount = Object.values(done).filter(Boolean).length;
  var total = S.meds.length;
  var remain = total - doneCount;
  if(ms) ms.textContent = doneCount+'/'+total+' 완료';
  if(mr) mr.textContent = remain > 0 ? '남은 복약: '+remain+'회' : '✓ 모두 완료!';
}
function isElapsed(timeStr) {
  var m = timeStr.match(/(\d+):(\d+)/);
  if (!m) return false;
  var t = new Date(); t.setHours(+m[1],+m[2],0,0);
  return new Date() > t;
}
function addMed(name, time) {
  if (!name) return false;
  if (!S.meds) S.meds = [];
  S.meds.push({ name:name, time:time, icon:ICONS[S.meds.length % ICONS.length] });
  save(); renderMeds(); renderMedStatus();
  return true;
}

// ── 로컬 데이터 표시 ───────────────────────────
function renderLocalData() {
  var el = document.getElementById('local-data-info');
  if (!el) return;
  var today = todayKey();
  var done = (S.medsDone && S.medsDone[today]) || {};
  var doneCount = Object.values(done).filter(Boolean).length;
  el.innerHTML =
    row('부모님 이름', esc(S.name)||'—') +
    row('전화번호', esc(S.phone)||'—') +
    row('등록된 복약', (S.meds?S.meds.length:0)+'종') +
    row('오늘 복약 완료', doneCount+'/'+(S.meds?S.meds.length:0)) +
    row('마지막 확인', S.lastCheck ? new Date(S.lastCheck).toLocaleString('ko-KR') : '—') +
    row('마지막 통화', S.lastCall ? new Date(S.lastCall).toLocaleString('ko-KR') : '—') +
    row('저장 위치', 'localStorage');
}
function row(label, value) {
  return '<div class="server-row"><span class="srv-label">'+label+'</span><span style="font-weight:600">'+value+'</span></div>';
}

// ── 서버 상태 ──────────────────────────────────
var _pollTimer;
function checkServer() {
  var info = document.getElementById('server-info');
  var dot  = document.getElementById('server-dot');
  var txt  = document.getElementById('server-status-text');
  var epP  = document.getElementById('ep-ping');
  var epH  = document.getElementById('ep-health');
  var t0 = Date.now();
  Promise.allSettled([
    fetch(API+'/ping',  {signal:AbortSignal.timeout(5000)}).then(function(r){return r.json();}),
    fetch(API+'/health',{signal:AbortSignal.timeout(5000)}).then(function(r){return r.json();})
  ]).then(function(results){
    var ms = Date.now() - t0;
    var ping   = results[0].status === 'fulfilled' ? results[0].value : null;
    var health = results[1].status === 'fulfilled' ? results[1].value : null;

    dot.className = ping ? 'status-dot ok' : 'status-dot warn';
    txt.textContent = ping ? '서버 정상' : '서버 오류';

    if (epP) { epP.className = ping ? 'srv-ok' : 'srv-err'; epP.textContent = ping ? '✓ 정상 ('+ms+'ms)' : '✗ 오류'; }
    if (epH) {
      var hs = health ? health.status : null;
      epH.className = (hs === 'ok') ? 'srv-ok' : 'srv-warn';
      epH.textContent = health ? hs : '✗ 응답없음';
    }
    if (info) info.innerHTML =
      row2('서버 응답', '<span class="srv-ok">✓ 정상 ('+new Date(ping?ping.ts:Date.now()).toLocaleTimeString()+')</span>')+
      row2('응답 속도', '<span style="font-weight:600">'+ms+'ms</span>')+
      row2('DB 상태', '<span class="srv-'+(health&&health.db==='ok'?'ok':'err')+'">'+(health&&health.db==='ok'?'✓ 연결됨':'✗ 연결 필요')+'</span>')+
      row2('Redis', '<span class="srv-'+(health&&health.redis==='ok'?'ok':'err')+'">'+(health&&health.redis==='ok'?'✓ 연결됨':'✗ 연결 필요')+'</span>')+
      row2('버전', '<span style="font-weight:600">'+(health?health.version:'?')+'</span>')+
      row2('마지막 확인', '<span style="font-weight:600">'+new Date().toLocaleTimeString('ko-KR')+'</span>');
  }).catch(function(){
    dot.className = 'status-dot err'; txt.textContent = '서버 오류';
    if(epP) { epP.className='srv-err'; epP.textContent='✗ 오류'; }
    if(epH) { epH.className='srv-err'; epH.textContent='✗ 오류'; }
    if(info) info.innerHTML = '<div style="color:var(--danger);text-align:center;padding:8px">서버에 연결할 수 없습니다</div>';
  });
}
function row2(label, valueHtml) {
  return '<div class="server-row"><span class="srv-label">'+label+'</span>'+valueHtml+'</div>';
}
function startPolling() {
  clearInterval(_pollTimer);
  _pollTimer = setInterval(checkServer, 30000);
}

// ── 유틸 ──────────────────────────────────────
function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 패널/모달 ──────────────────────────────────
function openFamily() {
  document.getElementById('family-overlay').classList.add('open');
  document.getElementById('family-panel').classList.add('open');
}
function closeFamily() {
  document.getElementById('family-overlay').classList.remove('open');
  document.getElementById('family-panel').classList.remove('open');
}
function openMap() { document.getElementById('map-modal').classList.add('open'); }
function closeMap() { document.getElementById('map-modal').classList.remove('open'); }

// ── 메인 진입점 ───────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  load();

  // 오래된 medsDone 정리 (7일 이상)
  if (S.medsDone) {
    var cutoff = new Date(); cutoff.setDate(cutoff.getDate()-7);
    Object.keys(S.medsDone).forEach(function(k){ if(new Date(k)<cutoff) delete S.medsDone[k]; });
    save();
  }

  // 온보딩 vs 메인
  if (S.done) {
    document.getElementById('onboarding').style.display = 'none';
    document.getElementById('main-app').style.display = 'block';
    initMain();
  } else {
    checkServer();
  }

  // ── 온보딩 버튼 ──
  document.getElementById('ob-name').addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('ob-btn-1').click(); });
  document.getElementById('ob-btn-1').addEventListener('click', function(){
    var name = document.getElementById('ob-name').value.trim();
    if (!name) { showToast('이름을 입력해주세요','warn'); return; }
    S.name = name; save(); obSetStep(2);
    document.getElementById('ob-phone').focus();
  });

  document.getElementById('ob-phone').addEventListener('input', function(){ formatPhone(this); });
  document.getElementById('ob-phone').addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('ob-btn-2').click(); });
  document.getElementById('ob-back-2').addEventListener('click', function(){ obSetStep(1); });
  document.getElementById('ob-btn-2').addEventListener('click', function(){
    var ph = document.getElementById('ob-phone').value.trim();
    if (ph) S.phone = ph; save(); obSetStep(3);
  });

  document.getElementById('ob-add-med').addEventListener('click', function(){
    var name = document.getElementById('ob-med-name').value.trim();
    var time = document.getElementById('ob-med-time').value;
    if (!name) { showToast('약 이름을 입력해주세요','warn'); return; }
    obMeds.push({name:name, time:time});
    document.getElementById('ob-med-name').value = '';
    obRenderMeds();
  });
  document.getElementById('ob-med-name').addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('ob-add-med').click(); });
  document.getElementById('ob-back-3').addEventListener('click', function(){ obSetStep(2); });
  document.getElementById('ob-btn-3').addEventListener('click', function(){
    S.meds = obMeds.map(function(m,i){ return {name:m.name,time:m.time,icon:ICONS[i%ICONS.length]}; });
    save(); obSetStep(4);
  });
  document.getElementById('ob-finish').addEventListener('click', function(){
    S.done = true; save();
    document.getElementById('onboarding').style.display = 'none';
    document.getElementById('main-app').style.display = 'block';
    initMain();
  });

  // ── 메인 앱 버튼 ──
  document.getElementById('btn-check-now').addEventListener('click', function(){
    S.lastCheck = new Date().toISOString(); save(); renderLastCheck();
    showToast('확인 시간을 업데이트했습니다','success');
  });
  document.getElementById('btn-call').addEventListener('click', function(){
    S.lastCall = new Date().toISOString(); save(); renderLastCall();
    showToast((S.name||'부모님')+'님께 전화합니다... (데모)','success');
  });
  document.getElementById('btn-msg').addEventListener('click', function(){
    document.getElementById('msg-form').classList.toggle('open');
  });
  document.getElementById('btn-close-msg').addEventListener('click', function(){
    document.getElementById('msg-form').classList.remove('open');
  });
  document.getElementById('btn-send-msg').addEventListener('click', function(){
    var txt = document.getElementById('msg-text').value.trim();
    if (!txt) { showToast('메시지를 입력해주세요','warn'); return; }
    showToast('안부 메시지를 보냈습니다! (데모)','success');
    document.getElementById('msg-text').value = '';
    document.getElementById('msg-form').classList.remove('open');
  });
  document.getElementById('btn-family').addEventListener('click', openFamily);
  document.getElementById('btn-map').addEventListener('click', openMap);
  document.getElementById('btn-add-med').addEventListener('click', function(){
    var name = document.getElementById('new-med-name').value.trim();
    var time = document.getElementById('new-med-time').value;
    if (!name) { showToast('약 이름을 입력해주세요','warn'); return; }
    addMed(name, time);
    document.getElementById('new-med-name').value = '';
    showToast(name+' 추가됐습니다','success');
  });
  document.getElementById('new-med-name').addEventListener('keydown', function(e){ if(e.key==='Enter') document.getElementById('btn-add-med').click(); });
  document.getElementById('btn-reset').addEventListener('click', function(){
    if (confirm('모든 데이터를 초기화하고 처음부터 다시 설정하시겠습니까?')) {
      localStorage.removeItem(STORE_KEY);
      location.reload();
    }
  });
  document.getElementById('btn-refresh-server').addEventListener('click', checkServer);
  document.getElementById('family-overlay').addEventListener('click', closeFamily);
  document.getElementById('family-close').addEventListener('click', closeFamily);
  document.getElementById('map-close').addEventListener('click', closeMap);
  document.getElementById('map-modal').addEventListener('click', function(e){ if(e.target===this) closeMap(); });

  ['fam-call-1','fam-call-2','fam-call-3'].forEach(function(id){
    document.getElementById(id).addEventListener('click', function(){
      showToast('전화 연결 중... (데모)','success');
    });
  });

  document.addEventListener('keydown', function(e){
    if (e.key==='Escape') { closeMap(); closeFamily(); }
  });

  // 1분마다 상대 시간 갱신
  setInterval(function(){
    if (S.done) { renderLastCheck(); renderLastCall(); }
  }, 60000);
});
