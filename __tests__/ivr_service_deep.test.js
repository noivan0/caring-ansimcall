'use strict';
/**
 * __tests__/ivr_service_deep.test.js
 * IvrService.js 심층 테스트 (14% → 70%+ 목표)
 * nova-qa 감사 R31
 *
 * 헤르2 체크포인트:
 * - Twilio HMAC 서명 검증 (신규 미들웨어)
 * - STT 파싱 다국어 (KO/JA/EN)
 * - 영어 단어 경계 오탐 방지 (no/yes 부분매칭)
 * - MedicationCallLog CRUD
 * - checkConsecutiveMissed 3일 연속 감지
 * - processIvrCall 통합 (실제 DB)
 * - DTMF 유효/무효 처리
 * - PII 마스킹 구조
 */

const Database = require('better-sqlite3');

// ── 실제 IvrService 사용 (mock 없음 — 커버리지 측정 목적) ──────
let IvrService;

beforeAll(() => {
  // 메모리 DB로 실행 (파일 생성 방지)
  process.env.IVR_CALL_LOG_DB_PATH = ':memory:';
  IvrService = require('../src/services/IvrService');
  // 메모리 DB 주입
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
  IvrService.MedicationCallLog._resetDb(memDb);
});

const today = () => new Date().toISOString().split('T')[0];
const daysBefore = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
};

// ── STT 파싱 — 한국어 ────────────────────────────────────────

describe('parseIvrResponse — 한국어 STT', () => {
  const { parseIvrResponse } = IvrService || {};

  beforeAll(() => {
    if (!IvrService) IvrService = require('../src/services/IvrService');
  });

  it('빈 입력 → NO_RESPONSE', () => {
    const r = IvrService.parseIvrResponse('');
    expect(r.confirmed).toBeNull();
    expect(r.response_type).toBe('NO_RESPONSE');
  });

  it('null → NO_RESPONSE', () => {
    const r = IvrService.parseIvrResponse(null);
    expect(r.response_type).toBe('NO_RESPONSE');
  });

  it('"네" → confirmed=true', () => {
    const r = IvrService.parseIvrResponse('네', 'ko');
    expect(r.confirmed).toBe(true);
    expect(r.response_type).toBe('STT');
  });

  it('"먹었어요" → confirmed=true', () => {
    expect(IvrService.parseIvrResponse('먹었어요', 'ko').confirmed).toBe(true);
  });

  it('"복용했습니다" → confirmed=true', () => {
    expect(IvrService.parseIvrResponse('복용했습니다', 'ko').confirmed).toBe(true);
  });

  it('"아니요" → confirmed=false', () => {
    expect(IvrService.parseIvrResponse('아니요', 'ko').confirmed).toBe(false);
  });

  it('"안먹었어요" → confirmed=false (부정어 우선)', () => {
    expect(IvrService.parseIvrResponse('안먹었어요', 'ko').confirmed).toBe(false);
  });

  it('"아직" → confirmed=false', () => {
    expect(IvrService.parseIvrResponse('아직', 'ko').confirmed).toBe(false);
  });

  it('키워드 없는 한국어 → NO_RESPONSE', () => {
    // 주의: "맑네요"처럼 "네"가 포함된 단어는 오탐 발생 (알려진 한국어 부분 매칭 이슈)
    // 현재 구현: includes() 사용으로 부분 매칭 — 단어 경계 미처리
    // TODO: 한국어도 단어 경계 처리 개선 필요
    const r = IvrService.parseIvrResponse('그냥 쉬고 있어요', 'ko');
    // "아직" 포함 없으므로 NO_RESPONSE 기대
    // 단, "있어요"에 "있" 등 미매칭 → null
    expect(r.confirmed).toBeNull();
  });
});

// ── STT 파싱 — 일본어 ────────────────────────────────────────

describe('parseIvrResponse — 일본어 STT', () => {
  it('"はい" → confirmed=true', () => {
    expect(IvrService.parseIvrResponse('はい', 'ja').confirmed).toBe(true);
  });

  it('"飲みました" → confirmed=true', () => {
    expect(IvrService.parseIvrResponse('飲みました', 'ja').confirmed).toBe(true);
  });

  it('"いいえ" → confirmed=false', () => {
    expect(IvrService.parseIvrResponse('いいえ', 'ja').confirmed).toBe(false);
  });

  it('"まだ" → confirmed=false', () => {
    expect(IvrService.parseIvrResponse('まだ', 'ja').confirmed).toBe(false);
  });
});

// ── STT 파싱 — 영어 + 단어 경계 오탐 방지 ───────────────────

describe('parseIvrResponse — 영어 + 단어 경계', () => {
  it('"yes" → confirmed=true', () => {
    expect(IvrService.parseIvrResponse('yes', 'en').confirmed).toBe(true);
  });

  it('"no" → confirmed=false', () => {
    expect(IvrService.parseIvrResponse('no', 'en').confirmed).toBe(false);
  });

  it('"i took it" → confirmed=true', () => {
    expect(IvrService.parseIvrResponse('i took it', 'en').confirmed).toBe(true);
  });

  it('"i forgot" → confirmed=false', () => {
    expect(IvrService.parseIvrResponse('i forgot', 'en').confirmed).toBe(false);
  });

  it('"yesterday" → NO_RESPONSE (yes 오탐 방지)', () => {
    // 단어 경계: "yes" in "yesterday" 매칭 금지
    const r = IvrService.parseIvrResponse('yesterday', 'en');
    expect(r.confirmed).not.toBe(true);
  });

  it('"noted" → NO_RESPONSE (no 오탐 방지)', () => {
    // 단어 경계: "no" in "noted" 매칭 금지
    const r = IvrService.parseIvrResponse('noted', 'en');
    expect(r.confirmed).not.toBe(false);
  });

  it('"knowledge" → NO_RESPONSE', () => {
    const r = IvrService.parseIvrResponse('knowledge', 'en');
    expect(r.confirmed).not.toBe(false);
  });
});

// ── DTMF 처리 ────────────────────────────────────────────────

describe('processDtmf', () => {
  it('1 → confirmed=true, DTMF', () => {
    const r = IvrService.processDtmf('1');
    expect(r.confirmed).toBe(true);
    expect(r.response_type).toBe('DTMF');
  });

  it('2 → confirmed=false, DTMF', () => {
    const r = IvrService.processDtmf('2');
    expect(r.confirmed).toBe(false);
  });

  it('0 → NO_RESPONSE (유효하지 않은 DTMF)', () => {
    expect(IvrService.processDtmf('0').confirmed).toBeNull();
  });

  it('9 → NO_RESPONSE', () => {
    expect(IvrService.processDtmf('9').confirmed).toBeNull();
  });

  it('* → NO_RESPONSE', () => {
    expect(IvrService.processDtmf('*').confirmed).toBeNull();
  });
});

// ── MedicationCallLog CRUD ────────────────────────────────────

describe('MedicationCallLog.create', () => {
  it('로그 저장 + 반환', () => {
    const log = IvrService.MedicationCallLog.create({
      userId: 'test-u1',
      date: today(),
      time: '09:00',
      medication: '혈압약',
      response_type: 'STT',
      confirmed: true,
      raw_response: '네',
    });
    expect(log).toBeDefined();
    expect(log.id).toBeGreaterThan(0);
    expect(log.confirmed).toBe(1);
  });

  it('markFamilyNotified 업데이트', () => {
    const log = IvrService.MedicationCallLog.create({
      userId: 'test-u2',
      date: today(),
      time: '09:00',
      medication: '당뇨약',
      response_type: 'DTMF',
      confirmed: false,
    });
    const result = IvrService.MedicationCallLog.markFamilyNotified(log.id);
    expect(result).toBe(true);
  });

  it('findByDate 조회', () => {
    const d = today();
    IvrService.MedicationCallLog.create({
      userId: 'u-find', date: d, time: '10:00',
      medication: '고혈압약', response_type: 'STT', confirmed: true,
    });
    const logs = IvrService.MedicationCallLog.findByDate('u-find', '고혈압약', d);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('findRecentMissed 조회', () => {
    // 미복약 3개 생성
    for (let i = 0; i < 3; i++) {
      IvrService.MedicationCallLog.create({
        userId: 'u-missed', date: daysBefore(i), time: '09:00',
        medication: '칼슘제', response_type: 'STT', confirmed: false,
        raw_response: '아직',
      });
    }
    const missed = IvrService.MedicationCallLog.findRecentMissed('u-missed', '칼슘제', 3);
    expect(missed.length).toBeGreaterThanOrEqual(3);
  });
});

// ── checkConsecutiveMissed ───────────────────────────────────

describe('checkConsecutiveMissed', () => {
  it('3일 연속 미복약 → true', () => {
    const uid = 'u-consec-true';
    for (let i = 0; i < 3; i++) {
      IvrService.MedicationCallLog.create({
        userId: uid, date: daysBefore(i), time: '09:00',
        medication: '혈압약', response_type: 'STT', confirmed: false,
        raw_response: '아니요',
      });
    }
    expect(IvrService.checkConsecutiveMissed(uid, '혈압약')).toBe(true);
  });

  it('2일만 미복약 → false (3일 미충족)', () => {
    const uid = 'u-consec-2day';
    for (let i = 0; i < 2; i++) {
      IvrService.MedicationCallLog.create({
        userId: uid, date: daysBefore(i), time: '09:00',
        medication: '당뇨약', response_type: 'DTMF', confirmed: false,
      });
    }
    expect(IvrService.checkConsecutiveMissed(uid, '당뇨약')).toBe(false);
  });

  it('신규 사용자 → false', () => {
    expect(IvrService.checkConsecutiveMissed('brand-new-user', '임의약')).toBe(false);
  });
});

// ── processIvrCall 통합 ─────────────────────────────────────

describe('processIvrCall — 통합', () => {
  it('STT 복약 확인 → log.confirmed=true', async () => {
    const result = await IvrService.processIvrCall({
      userId: 'int-u1',
      medication: '혈압약',
      rawText: '네',
      lang: 'ko',
      date: today(),
      time: '09:00',
    });
    expect(result.parsed.confirmed).toBe(true);
    expect(result.log).toBeDefined();
    expect(result.notified_family).toBe(false);
  });

  it('DTMF 미복약 → parsed.confirmed=false', async () => {
    const result = await IvrService.processIvrCall({
      userId: 'int-u2',
      medication: '당뇨약',
      dtmfDigit: '2',
      date: today(),
      time: '09:00',
    });
    expect(result.parsed.confirmed).toBe(false);
    expect(result.parsed.response_type).toBe('DTMF');
  });

  it('3일 연속 미복약 → notified_family=true', async () => {
    const uid = 'int-u-3day';
    // 2일치 먼저 입력
    for (let i = 1; i <= 2; i++) {
      IvrService.MedicationCallLog.create({
        userId: uid, date: daysBefore(i), time: '09:00',
        medication: '칼슘제', response_type: 'DTMF', confirmed: false,
      });
    }
    // 오늘 미복약 → 3일 연속
    const result = await IvrService.processIvrCall({
      userId: uid, medication: '칼슘제',
      dtmfDigit: '2', date: today(), time: '09:00',
    });
    expect(result.notified_family).toBe(true);
    expect(result.consecutive_missed).toBe(true);
  });
});

// ── Twilio Webhook 서명 검증 (Twilio validateRequest contract) ───────────────

describe('validateTwilioSignature — Twilio X-Twilio-Signature (SHA1 helper contract)', () => {
  const { validateTwilioSignature } = require('../src/middleware/twilioAuth');
  const crypto = require('crypto');

  const authToken = 'test-auth-token-secret';
  const url = 'https://example.com/api/medication/ivr-response';
  const params = { CallSid: 'CA123', userId: 'u1', Digits: '1' };

  function buildExpectedSignature(token, url, params) {
    let str = url;
    const sortedKeys = Object.keys(params).sort();
    for (const key of sortedKeys) str += key + params[key];
    return crypto.createHmac('sha1', token).update(Buffer.from(str, 'utf-8')).digest('base64');
  }

  it('올바른 서명 → true', () => {
    const sig = buildExpectedSignature(authToken, url, params);
    expect(validateTwilioSignature(authToken, sig, url, params)).toBe(true);
  });

  it('잘못된 서명 → false', () => {
    expect(validateTwilioSignature(authToken, 'wrong-signature', url, params)).toBe(false);
  });

  it('빈 authToken → false', () => {
    expect(validateTwilioSignature('', 'sig', url, params)).toBe(false);
  });

  it('빈 signature → false', () => {
    expect(validateTwilioSignature(authToken, '', url, params)).toBe(false);
  });

  it('파라미터 없을 때도 검증 가능', () => {
    const sig = buildExpectedSignature(authToken, url, {});
    expect(validateTwilioSignature(authToken, sig, url, {})).toBe(true);
  });

  it('파라미터 순서 달라도 동일 서명', () => {
    const paramsReversed = { Digits: '1', userId: 'u1', CallSid: 'CA123' };
    const sig = buildExpectedSignature(authToken, url, params);
    expect(validateTwilioSignature(authToken, sig, url, paramsReversed)).toBe(true);
  });

  it('커스텀 SHA256 서명은 허용하지 않음', () => {
    let str = url;
    const sortedKeys = Object.keys(params).sort();
    for (const key of sortedKeys) str += key + params[key];
    const sha256Sig = crypto.createHmac('sha256', authToken)
      .update(Buffer.from(str, 'utf-8'))
      .digest('base64');
    expect(validateTwilioSignature(authToken, sha256Sig, url, params)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// HIGH BUG FIX 회귀 테스트 — includes() 오탐 방지 (R32)
// ─────────────────────────────────────────────────────────────
describe('parseIvrResponse — 한국어 오탐 방지 회귀테스트', () => {
  let parseIvrResponse;

  beforeAll(() => {
    parseIvrResponse = IvrService.parseIvrResponse;
  });

  // 오탐 케이스 — 이전 includes() 방식에서 CONFIRM으로 잘못 분류됨
  it('"맑네요" → NO_RESPONSE (오탐 방지)', () => {
    const r = parseIvrResponse('맑네요', 'ko');
    expect(r.confirmed).toBeNull();
  });

  it('"아니네요" → DENY (^아니 regex 매칭)', () => {
    const r = parseIvrResponse('아니네요', 'ko');
    // '아니네요'는 ^아니 regex에 매칭 → DENY
    expect(r.confirmed).toBe(false);
  });

  it('"그건 맞는 말인데요" → NO_RESPONSE (맞 오탐 방지)', () => {
    const r = parseIvrResponse('그건 맞는 말인데요', 'ko');
    expect(r.confirmed).toBeNull();
  });

  it('"아직은 아닌 것 같아요" → NO_RESPONSE (아직 포함 문장)', () => {
    // '아직'이 Set에 있지만 normalize 후 전체 문장이므로 Set.has() 미매칭
    // regex ^아니 패턴도 미적용
    const r = parseIvrResponse('아직은 아닌 것 같아요', 'ko');
    // '아닌' → ^아니 regex 미매칭 (앵커가 전체 normalized에 적용됨)
    // 실제 DENY는 normalized='아직은 아닌 것 같아요' → Set miss, regex miss → NO_RESPONSE
    expect(r.confirmed).toBeNull();
  });

  it('"예전에 먹었던 것 같아요" → NO_RESPONSE (예전 오탐 방지)', () => {
    // 이전에 '예'가 includes로 오탐했을 수 있음
    const r = parseIvrResponse('예전에 먹었던 것 같아요', 'ko');
    expect(r.confirmed).toBeNull();
  });

  // 정상 케이스 — Set 정확 매칭
  it('"네" (단독) → confirmed=true', () => {
    const r = parseIvrResponse('네', 'ko');
    expect(r.confirmed).toBe(true);
  });

  it('"네." → confirmed=true (regex 앵커)', () => {
    const r = parseIvrResponse('네.', 'ko');
    expect(r.confirmed).toBe(true);
  });

  it('"네," → confirmed=true', () => {
    const r = parseIvrResponse('네,', 'ko');
    expect(r.confirmed).toBe(true);
  });

  it('"아니요" → confirmed=false', () => {
    const r = parseIvrResponse('아니요', 'ko');
    expect(r.confirmed).toBe(false);
  });

  it('"먹었어요" → confirmed=true', () => {
    const r = parseIvrResponse('먹었어요', 'ko');
    expect(r.confirmed).toBe(true);
  });

  it('"모르겠어요" → confirmed=false', () => {
    const r = parseIvrResponse('모르겠어요', 'ko');
    expect(r.confirmed).toBe(false);
  });
});

describe('classifyKorean — whitelist Set 직접 검증', () => {
  let classifyKorean;

  beforeAll(() => {
    classifyKorean = IvrService.classifyKorean;
  });

  it('Set 정확 매칭: "네" → CONFIRM', () => {
    expect(classifyKorean('네')).toBe('CONFIRM');
  });

  it('Set 외 문장: "맑네요" → null (UNKNOWN)', () => {
    expect(classifyKorean('맑네요')).toBeNull();
  });

  it('regex 앵커: "네!" → CONFIRM', () => {
    expect(classifyKorean('네!')).toBe('CONFIRM');
  });

  it('regex ^아니: "아니..." → DENY', () => {
    expect(classifyKorean('아니그게아니라')).toBe('DENY');
  });

  it('"맞습니다" → CONFIRM', () => {
    expect(classifyKorean('맞습니다')).toBe('CONFIRM');
  });

  it('"알겠습니다" → CONFIRM', () => {
    expect(classifyKorean('알겠습니다')).toBe('CONFIRM');
  });
});
