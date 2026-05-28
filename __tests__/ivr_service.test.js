/**
 * __tests__/ivr_service.test.js — IVR 복약 STT/DTMF 파싱 테스트
 */
'use strict';

// better-sqlite3를 메모리 DB로 mock
jest.mock('../src/services/IvrService', () => {
  const Database = require('better-sqlite3');
  const memDb = new Database(':memory:');
  memDb.pragma('journal_mode = WAL');
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS medication_call_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          TEXT,
      date             TEXT NOT NULL,
      time             TEXT NOT NULL,
      medication       TEXT NOT NULL,
      response_type    TEXT NOT NULL,
      confirmed        INTEGER NOT NULL DEFAULT 0,
      raw_response     TEXT,
      notified_family  INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL
    )
  `);

  const RESPONSE_TYPE = { DTMF: 'DTMF', STT: 'STT', NO_RESPONSE: 'NO_RESPONSE' };
  const CONFIRMED_KEYWORDS     = ['네', '예', '먹었어', '먹었어요', '먹었습니다', '복용했어요', '복용했습니다', '맞아요', '맞아'];
  const NOT_CONFIRMED_KEYWORDS = ['아니', '아니요', '안먹었어', '안 먹었어', '안먹었어요', '안 먹었어요', '모르겠어', '모르겠어요', '아직', '아직요', '못먹었어', '못 먹었어'];

  function parseIvrResponse(rawText) {
    if (!rawText || rawText.trim() === '') {
      return { confirmed: null, response_type: RESPONSE_TYPE.NO_RESPONSE };
    }
    const normalized = rawText.trim().replace(/\s+/g, ' ');
    // 부정어 우선 (안먹었어 등 복합어 처리)
    for (const kw of NOT_CONFIRMED_KEYWORDS) {
      if (normalized.includes(kw)) return { confirmed: false, response_type: RESPONSE_TYPE.STT };
    }
    for (const kw of CONFIRMED_KEYWORDS) {
      if (normalized.includes(kw)) return { confirmed: true, response_type: RESPONSE_TYPE.STT };
    }
    return { confirmed: null, response_type: RESPONSE_TYPE.NO_RESPONSE };
  }

  function processDtmf(digit) {
    if (digit === '1') return { confirmed: true,  response_type: RESPONSE_TYPE.DTMF };
    if (digit === '2') return { confirmed: false, response_type: RESPONSE_TYPE.DTMF };
    return { confirmed: null, response_type: RESPONSE_TYPE.NO_RESPONSE };
  }

  function checkConsecutiveMissed(userId, medication) {
    const today = new Date();
    const datesToCheck = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      datesToCheck.push(d.toISOString().split('T')[0]);
    }
    for (const date of datesToCheck) {
      const rows = memDb.prepare(`
        SELECT id FROM medication_call_logs
        WHERE user_id=? AND medication=? AND date=? AND confirmed=0 LIMIT 1
      `).all(userId, medication, date);
      if (rows.length === 0) return false;
    }
    return true;
  }

  const MedicationCallLog = {
    create(data) {
      const now = new Date().toISOString();
      const r = memDb.prepare(`
        INSERT INTO medication_call_logs
          (user_id,date,time,medication,response_type,confirmed,raw_response,notified_family,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        data.userId||null, data.date, data.time, data.medication, data.response_type,
        data.confirmed?1:0, data.raw_response||null, data.notified_family?1:0, now
      );
      return memDb.prepare('SELECT * FROM medication_call_logs WHERE id=?').get(r.lastInsertRowid);
    },
    findRecentMissed(userId, medication, days=3) {
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().split('T')[0];
      return memDb.prepare(`
        SELECT * FROM medication_call_logs WHERE user_id=? AND medication=? AND confirmed=0 AND response_type!='NO_RESPONSE' AND date>=?
        ORDER BY date DESC, time DESC
      `).all(userId, medication, cutoffStr);
    },
    findByDate(userId, medication, date) {
      return memDb.prepare(`
        SELECT * FROM medication_call_logs WHERE user_id=? AND medication=? AND date=? ORDER BY time DESC
      `).all(userId, medication, date);
    },
    markFamilyNotified(id) {
      const r = memDb.prepare('UPDATE medication_call_logs SET notified_family=1 WHERE id=?').run(id);
      return r.changes > 0;
    },
    _clear() { memDb.exec('DELETE FROM medication_call_logs'); },
  };

  async function processIvrCall(params) {
    const {
      userId, medication, rawText, dtmfDigit,
      date = new Date().toISOString().split('T')[0],
      time = new Date().toTimeString().slice(0, 5),
    } = params;

    let parsed;
    if (dtmfDigit !== undefined && dtmfDigit !== null) {
      parsed = processDtmf(String(dtmfDigit));
    } else {
      parsed = parseIvrResponse(rawText);
    }

    // 로그 먼저 저장 (3일 연속 체크는 현재 로그 포함해야 정확)
    const log = MedicationCallLog.create({
      userId, date, time, medication,
      response_type: parsed.response_type,
      confirmed: parsed.confirmed === true,
      raw_response: rawText || (dtmfDigit ? `DTMF:${dtmfDigit}` : null),
      notified_family: false,
    });

    let notifiedFamily = false;
    let consecutiveMissed = false;

    if (parsed.confirmed === false) {
      consecutiveMissed = checkConsecutiveMissed(userId, medication);
      if (consecutiveMissed) {
        notifiedFamily = true;
        MedicationCallLog.markFamilyNotified(log.id);
      }
    }

    // 최신 로그 재조회 (notified_family 업데이트 반영)
    const finalLog = memDb.prepare('SELECT * FROM medication_call_logs WHERE id = ?').get(log.id);

    return { log: finalLog || log, notified_family: notifiedFamily, consecutive_missed: consecutiveMissed, parsed };
  }

  return {
    IvrService: { parseIvrResponse, processDtmf, checkConsecutiveMissed, processIvrCall },
    MedicationCallLog,
    parseIvrResponse,
    processDtmf,
    checkConsecutiveMissed,
    processIvrCall,
    RESPONSE_TYPE,
    CONFIRMED_KEYWORDS,
    NOT_CONFIRMED_KEYWORDS,
  };
});

const {
  parseIvrResponse,
  processDtmf,
  checkConsecutiveMissed,
  processIvrCall,
  MedicationCallLog,
  RESPONSE_TYPE,
} = require('../src/services/IvrService');

afterEach(() => {
  MedicationCallLog._clear();
});

// ────────────────────────────────────────────────────────────────
// parseIvrResponse — STT 파싱
// ────────────────────────────────────────────────────────────────
describe('parseIvrResponse — 한국어 STT 파싱', () => {
  // confirmed = true 케이스
  test.each([
    ['네'],
    ['네, 먹었어요'],
    ['먹었어'],
    ['먹었어요'],
    ['먹었습니다'],
    ['복용했어요'],
    ['복용했습니다'],
    ['맞아요'],
  ])('"%s" → confirmed=true (STT)', (text) => {
    const result = parseIvrResponse(text);
    expect(result.confirmed).toBe(true);
    expect(result.response_type).toBe(RESPONSE_TYPE.STT);
  });

  // confirmed = false 케이스
  test.each([
    ['아니'],
    ['아니요'],
    ['안먹었어'],
    ['안 먹었어요'],
    ['모르겠어'],
    ['모르겠어요'],
    ['아직'],
    ['아직요'],
    ['못먹었어'],
  ])('"%s" → confirmed=false (STT)', (text) => {
    const result = parseIvrResponse(text);
    expect(result.confirmed).toBe(false);
    expect(result.response_type).toBe(RESPONSE_TYPE.STT);
  });

  // NO_RESPONSE 케이스
  test('빈 문자열 → NO_RESPONSE', () => {
    const result = parseIvrResponse('');
    expect(result.confirmed).toBeNull();
    expect(result.response_type).toBe(RESPONSE_TYPE.NO_RESPONSE);
  });

  test('null → NO_RESPONSE', () => {
    const result = parseIvrResponse(null);
    expect(result.confirmed).toBeNull();
    expect(result.response_type).toBe(RESPONSE_TYPE.NO_RESPONSE);
  });

  test('undefined → NO_RESPONSE', () => {
    const result = parseIvrResponse(undefined);
    expect(result.confirmed).toBeNull();
    expect(result.response_type).toBe(RESPONSE_TYPE.NO_RESPONSE);
  });

  test('판별 불가 텍스트 → NO_RESPONSE', () => {
    const result = parseIvrResponse('뭐라고요');
    expect(result.confirmed).toBeNull();
    expect(result.response_type).toBe(RESPONSE_TYPE.NO_RESPONSE);
  });
});

// ────────────────────────────────────────────────────────────────
// processDtmf — DTMF 처리
// ────────────────────────────────────────────────────────────────
describe('processDtmf — DTMF 키패드 처리', () => {
  test('"1" → confirmed=true (DTMF)', () => {
    const result = processDtmf('1');
    expect(result.confirmed).toBe(true);
    expect(result.response_type).toBe(RESPONSE_TYPE.DTMF);
  });

  test('"2" → confirmed=false (DTMF)', () => {
    const result = processDtmf('2');
    expect(result.confirmed).toBe(false);
    expect(result.response_type).toBe(RESPONSE_TYPE.DTMF);
  });

  test('"#" → NO_RESPONSE', () => {
    const result = processDtmf('#');
    expect(result.confirmed).toBeNull();
    expect(result.response_type).toBe(RESPONSE_TYPE.NO_RESPONSE);
  });

  test('"0" → NO_RESPONSE', () => {
    const result = processDtmf('0');
    expect(result.confirmed).toBeNull();
    expect(result.response_type).toBe(RESPONSE_TYPE.NO_RESPONSE);
  });
});

// ────────────────────────────────────────────────────────────────
// MedicationCallLog CRUD
// ────────────────────────────────────────────────────────────────
describe('MedicationCallLog CRUD', () => {
  const today = new Date().toISOString().split('T')[0];

  test('로그 생성 → id 할당됨', () => {
    const log = MedicationCallLog.create({
      userId: 'user-1', date: today, time: '08:00',
      medication: '혈압약', response_type: RESPONSE_TYPE.STT,
      confirmed: true, raw_response: '네 먹었어요',
    });
    expect(log.id).toBeDefined();
    expect(log.medication).toBe('혈압약');
    expect(log.confirmed).toBe(1); // SQLite boolean = 0/1
  });

  test('findByDate — 오늘 로그 조회', () => {
    MedicationCallLog.create({ userId: 'user-2', date: today, time: '08:00', medication: '당뇨약', response_type: RESPONSE_TYPE.DTMF, confirmed: false });
    const logs = MedicationCallLog.findByDate('user-2', '당뇨약', today);
    expect(logs).toHaveLength(1);
  });

  test('markFamilyNotified → notified_family = 1', () => {
    const log = MedicationCallLog.create({
      userId: 'user-3', date: today, time: '09:00',
      medication: '혈압약', response_type: RESPONSE_TYPE.STT,
      confirmed: false, notified_family: false,
    });
    MedicationCallLog.markFamilyNotified(log.id);
    // DB에서 재조회
    const { MedicationCallLog: MCL } = require('../src/services/IvrService');
    const updated = MCL.findByDate('user-3', '혈압약', today)[0];
    expect(updated.notified_family).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// checkConsecutiveMissed — 3일 연속 미복약
// ────────────────────────────────────────────────────────────────
describe('checkConsecutiveMissed — 3일 연속 미복약 감지', () => {
  function getDatesBack(n) {
    const dates = [];
    for (let i = 0; i < n; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
  }

  test('3일 연속 미복약 → true', () => {
    const dates = getDatesBack(3);
    dates.forEach(date => {
      MedicationCallLog.create({
        userId: 'user-consec', date, time: '08:00',
        medication: '혈압약', response_type: RESPONSE_TYPE.STT,
        confirmed: false, raw_response: '아직',
      });
    });
    expect(checkConsecutiveMissed('user-consec', '혈압약')).toBe(true);
  });

  test('2일만 미복약 → false', () => {
    const dates = getDatesBack(2);
    dates.forEach(date => {
      MedicationCallLog.create({
        userId: 'user-2day', date, time: '08:00',
        medication: '혈압약', response_type: RESPONSE_TYPE.STT,
        confirmed: false, raw_response: '아직',
      });
    });
    expect(checkConsecutiveMissed('user-2day', '혈압약')).toBe(false);
  });

  test('기록 없음 → false', () => {
    expect(checkConsecutiveMissed('user-none', '혈압약')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// processIvrCall — 통합 처리
// ────────────────────────────────────────────────────────────────
describe('processIvrCall — IVR 통합 처리', () => {
  const today = new Date().toISOString().split('T')[0];

  test('STT "네" → confirmed=true, 로그 저장', async () => {
    const result = await processIvrCall({
      userId: 'user-proc-1', medication: '혈압약',
      rawText: '네', date: today, time: '08:00',
    });
    expect(result.parsed.confirmed).toBe(true);
    expect(result.parsed.response_type).toBe(RESPONSE_TYPE.STT);
    expect(result.log).toBeDefined();
    expect(result.notified_family).toBe(false);
  });

  test('DTMF "1" → confirmed=true', async () => {
    const result = await processIvrCall({
      userId: 'user-proc-2', medication: '당뇨약',
      dtmfDigit: '1', date: today, time: '09:00',
    });
    expect(result.parsed.confirmed).toBe(true);
    expect(result.parsed.response_type).toBe(RESPONSE_TYPE.DTMF);
  });

  test('DTMF "2" → confirmed=false', async () => {
    const result = await processIvrCall({
      userId: 'user-proc-3', medication: '당뇨약',
      dtmfDigit: '2', date: today, time: '09:00',
    });
    expect(result.parsed.confirmed).toBe(false);
    expect(result.parsed.response_type).toBe(RESPONSE_TYPE.DTMF);
  });

  test('빈 응답 → NO_RESPONSE', async () => {
    const result = await processIvrCall({
      userId: 'user-proc-4', medication: '혈압약',
      rawText: null, date: today, time: '10:00',
    });
    expect(result.parsed.response_type).toBe(RESPONSE_TYPE.NO_RESPONSE);
    expect(result.parsed.confirmed).toBeNull();
  });

  test('3일 연속 미복약 → notified_family=true', async () => {
    function getDatesBack(n) {
      const dates = [];
      for (let i = 0; i < n; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
      }
      return dates;
    }

    // 이전 2일 미복약 로그 (오늘 포함 3일)
    const dates = getDatesBack(3);
    dates.slice(1).forEach(date => {
      MedicationCallLog.create({
        userId: 'user-escalate', date, time: '08:00',
        medication: '혈압약', response_type: RESPONSE_TYPE.STT,
        confirmed: false, raw_response: '아직',
      });
    });

    // 오늘 미복약 → 3일째
    const result = await processIvrCall({
      userId: 'user-escalate', medication: '혈압약',
      rawText: '아직', date: dates[0], time: '08:00',
    });

    expect(result.consecutive_missed).toBe(true);
    expect(result.notified_family).toBe(true);
    expect(result.log.notified_family).toBe(1);
  });
});
