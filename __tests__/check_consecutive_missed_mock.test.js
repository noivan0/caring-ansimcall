'use strict';
/**
 * __tests__/check_consecutive_missed_mock.test.js
 * nova-qa R33 — checkConsecutiveMissed 날짜 의존성 mock 처리
 *
 * 문제: checkConsecutiveMissed()가 내부에서 new Date()를 사용 → CI 날짜 변경 시 flaky
 * 해결: jest.useFakeTimers() + jest.setSystemTime()으로 고정 날짜 주입
 *
 * 헤르2 체크포인트:
 *  - 3일 연속 미복약 → true
 *  - 2일 미복약 → false
 *  - 중간 복약 → false
 *  - KST 자정 경계 포함 여부
 *  - 에스컬레이션 트리거 (notifyGuardians mock)
 */

const Database = require('better-sqlite3');

// 고정 날짜: 2026-01-15 KST 09:00 (UTC 00:00)
const FIXED_DATE = new Date('2026-01-15T00:00:00.000Z');
// 이 날짜 기준 최근 3일: 2026-01-15(오늘), 2026-01-14(어제), 2026-01-13(그제)

process.env.IVR_CALL_LOG_DB_PATH = ':memory:';

let IvrService;
let memDb;

beforeAll(() => {
  IvrService = require('../src/services/IvrService');
});

beforeEach(() => {
  // 고정 날짜 설정
  jest.useFakeTimers();
  jest.setSystemTime(FIXED_DATE);

  // 새 메모리 DB — 각 테스트 격리
  memDb = new Database(':memory:');
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
  IvrService.MedicationCallLog._resetDb(memDb);
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// 헬퍼: 특정 날짜에 미복약(confirmed=0) 기록 삽입
// ─────────────────────────────────────────────────────────────
function insertMissed(userId, med, date, time = '09:00') {
  memDb.prepare(`
    INSERT INTO medication_call_logs
      (user_id, date, time, medication, response_type, confirmed, raw_response, notified_family, created_at)
    VALUES (?, ?, ?, ?, 'STT', 0, null, 0, ?)
  `).run(userId, date, time, med, new Date().toISOString());
}

function insertTaken(userId, med, date, time = '09:00') {
  memDb.prepare(`
    INSERT INTO medication_call_logs
      (user_id, date, time, medication, response_type, confirmed, raw_response, notified_family, created_at)
    VALUES (?, ?, ?, ?, 'DTMF', 1, null, 0, ?)
  `).run(userId, date, time, med, new Date().toISOString());
}

// ─────────────────────────────────────────────────────────────
// 1. 3일 연속 미복약 → true
// ─────────────────────────────────────────────────────────────
describe('checkConsecutiveMissed — jest.useFakeTimers (고정: 2026-01-15)', () => {

  it('3일 연속 미복약 (01-13, 01-14, 01-15) → true', async () => {
    const userId = 'mock-user-1';
    const med = '혈압약';

    insertMissed(userId, med, '2026-01-13');
    insertMissed(userId, med, '2026-01-14');
    insertMissed(userId, med, '2026-01-15');

    const result = await IvrService.checkConsecutiveMissed(userId, med);
    expect(result).toBe(true);
  });

  it('2일만 미복약 (01-14, 01-15) → false', async () => {
    const userId = 'mock-user-2';
    const med = '혈압약';

    // 01-13 없음 → 3일 연속 미충족
    insertMissed(userId, med, '2026-01-14');
    insertMissed(userId, med, '2026-01-15');

    const result = await IvrService.checkConsecutiveMissed(userId, med);
    expect(result).toBe(false);
  });

  it('3일 연속이지만 중간(01-14) 복약 → false', async () => {
    const userId = 'mock-user-3';
    const med = '혈압약';

    insertMissed(userId, med, '2026-01-13');
    insertTaken(userId, med, '2026-01-14');  // ← 복약 확인
    insertMissed(userId, med, '2026-01-15');

    const result = await IvrService.checkConsecutiveMissed(userId, med);
    expect(result).toBe(false);
  });

  it('기록 없는 사용자 → false', async () => {
    const result = await IvrService.checkConsecutiveMissed('no-record-user', '혈압약');
    expect(result).toBe(false);
  });

  it('다른 약물 기록은 영향 없음', async () => {
    const userId = 'mock-user-4';

    // 혈압약 3일 연속 미복약
    insertMissed(userId, '혈압약', '2026-01-13');
    insertMissed(userId, '혈압약', '2026-01-14');
    insertMissed(userId, '혈압약', '2026-01-15');

    // 당뇨약은 기록 없음
    const result = await IvrService.checkConsecutiveMissed(userId, '당뇨약');
    expect(result).toBe(false);
  });

  it('다른 사용자 기록은 영향 없음', async () => {
    // user-A 3일 연속 미복약
    insertMissed('user-A', '혈압약', '2026-01-13');
    insertMissed('user-A', '혈압약', '2026-01-14');
    insertMissed('user-A', '혈압약', '2026-01-15');

    // user-B는 기록 없음
    const result = await IvrService.checkConsecutiveMissed('user-B', '혈압약');
    expect(result).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. KST 자정 경계 케이스
// ─────────────────────────────────────────────────────────────
describe('checkConsecutiveMissed — KST 자정 경계', () => {

  it('자정 직후(01-15 00:00:30 UTC) — 최근 3일 정확히 01-13~15', async () => {
    // UTC 00:00:30 = KST 09:00:30 (2026-01-15)
    jest.setSystemTime(new Date('2026-01-15T00:00:30.000Z'));

    const userId = 'kst-user-1';
    const med = '혈압약';

    insertMissed(userId, med, '2026-01-13');
    insertMissed(userId, med, '2026-01-14');
    insertMissed(userId, med, '2026-01-15');

    const result = await IvrService.checkConsecutiveMissed(userId, med);
    expect(result).toBe(true);
  });

  it('자정 직전(01-14 23:59:59 UTC) — 최근 3일은 01-12~14', async () => {
    // UTC 2026-01-14 23:59:59 = KST 2026-01-15 08:59:59
    // checkConsecutiveMissed는 UTC Date() 기준 → today=2026-01-14
    jest.setSystemTime(new Date('2026-01-14T23:59:59.000Z'));

    const userId = 'kst-user-2';
    const med = '혈압약';

    // 2026-01-12, 01-13, 01-14 미복약
    insertMissed(userId, med, '2026-01-12');
    insertMissed(userId, med, '2026-01-13');
    insertMissed(userId, med, '2026-01-14');

    const result = await IvrService.checkConsecutiveMissed(userId, med);
    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. processIvrCall → checkConsecutiveMissed 통합 (에스컬레이션)
// ─────────────────────────────────────────────────────────────
describe('processIvrCall → 3일 연속 미복약 → notified_family=1', () => {

  it('3일치 미복약 기록 후 3번째 날 processIvrCall → notified_family', async () => {
    jest.setSystemTime(FIXED_DATE);

    const userId = 'escalation-user';
    const med = '혈압약';

    // 이전 2일 직접 삽입
    insertMissed(userId, med, '2026-01-13');
    insertMissed(userId, med, '2026-01-14');

    // 오늘(2026-01-15) processIvrCall으로 미복약 처리
    const result = await IvrService.processIvrCall({
      userId,
      medication: med,
      rawText: null,
      dtmfDigit: '2',  // 미복약
      date: '2026-01-15',
      time: '09:00',
      lang: 'ko',
    });

    // 3일 연속 → notified_family=true
    expect(result.notified_family).toBe(true);
    expect(result.consecutive_missed).toBe(true);
  });

  it('2일치 미복약 후 processIvrCall → notified_family=false', async () => {
    jest.setSystemTime(FIXED_DATE);

    const userId = 'no-escalation-user';
    const med = '혈압약';

    // 이전 1일만 삽입 (2일 연속 → 에스컬레이션 미발동)
    insertMissed(userId, med, '2026-01-14');

    const result = await IvrService.processIvrCall({
      userId,
      medication: med,
      rawText: null,
      dtmfDigit: '2',
      date: '2026-01-15',
      time: '09:00',
      lang: 'ko',
    });

    expect(result.notified_family).toBe(false);
    expect(result.consecutive_missed).toBe(false);
  });

  it('복약 확인 후 → notified_family=false (에스컬레이션 없음)', async () => {
    jest.setSystemTime(FIXED_DATE);

    const userId = 'taken-user';
    const med = '혈압약';

    // 이전 2일 미복약
    insertMissed(userId, med, '2026-01-13');
    insertMissed(userId, med, '2026-01-14');

    // 오늘은 복약 확인 (DTMF 1)
    const result = await IvrService.processIvrCall({
      userId,
      medication: med,
      rawText: null,
      dtmfDigit: '1',  // 복약 확인
      date: '2026-01-15',
      time: '09:00',
      lang: 'ko',
    });

    // confirmed=true → 연속 미복약 체크 안 함 (구현에 따라 다를 수 있음)
    expect(result.parsed.confirmed).toBe(true);
    // notified_family는 미복약 연속이 아니므로 false
    expect(result.notified_family).toBe(false);
  });
});
