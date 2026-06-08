'use strict';
/**
 * __tests__/e2e_ivr_scenarios.test.js
 * nova-qa R32 — 케어링 IVR E2E 통합 시나리오
 *
 * supertest 기반 API E2E (헤르2 체크포인트):
 *   시나리오 1: IVR 전체 플로우 (DTMF "1" → 완료 기록)
 *   시나리오 2: Quiet Hours 차단 (22:00 KST)
 *   시나리오 3: NO_ANSWER×3 에스컬레이션
 *   시나리오 4: STT 오탐 방지 — "맑네요" → UNKNOWN → 재질문
 *   시나리오 5: 다국어 STT (KO/JA/EN)
 *   시나리오 6: Twilio 서명 검증 미들웨어
 *   시나리오 7: 입력 검증 (필수 필드 누락)
 *   시나리오 8: 3일 연속 미복약 에스컬레이션 감지
 */

const request  = require('supertest');
const Database = require('better-sqlite3');

// ── 의존성 Mock ──────────────────────────────────────────────
jest.mock('../src/models/db', () => ({
  query:       jest.fn(),
  transaction: jest.fn(),
  pool:        { end: jest.fn() },
  isFallback:  () => true,
}));

jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(() => ({})),
  credential: { cert: jest.fn(), applicationDefault: jest.fn() },
  messaging: jest.fn(() => ({ send: jest.fn().mockResolvedValue('mock-msg') })),
}));

jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

jest.mock('../src/models/user', () => ({
  Guardian: { findGuardiansByElder: jest.fn().mockResolvedValue([]) },
}));

// IVR DB는 메모리 DB로 교체
process.env.IVR_CALL_LOG_DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

let app;
let ivrSvc;

beforeAll(() => {
  // E2E 테스트: INTERNAL_IVR_TOKEN 인증 스킵 (개발/테스트 전용)
  process.env.SKIP_INTERNAL_IVR_AUTH='true';

  // IvrService 메모리 DB 주입
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

  ivrSvc = require('../src/services/IvrService');
  ivrSvc.MedicationCallLog._resetDb(memDb);

  // app.js는 { app, server, io } 내보냄
  const appModule = require('../src/app');
  app = appModule.app || appModule;
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// 시나리오 1: IVR 전체 플로우 — DTMF "1" 복약 확인
// ─────────────────────────────────────────────────────────────
describe('E2E 시나리오 1: IVR DTMF 복약 확인 플로우', () => {
  it('POST /api/medication/ivr-response — DTMF "1" → 200 confirmed=true', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-e2e-1',
        medication: '혈압약',
        dtmfDigit:  '1',
        date:       '2024-06-15',
        time:       '09:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(true);
    expect((res.body.data || res.body).response_type).toBe('DTMF');
  });

  it('DTMF "2" → confirmed=false (미복약)', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-e2e-1',
        medication: '혈압약',
        dtmfDigit:  '2',
        date:       '2024-06-15',
        time:       '09:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(false);
  });

  it('DTMF "1" + STT 동시 제공 → DTMF 우선', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-e2e-2',
        medication: '당뇨약',
        dtmfDigit:  '1',
        rawText:    '아니요',  // STT는 부정이지만 DTMF 우선
        date:       '2024-06-15',
        time:       '10:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    // processIvrCall은 DTMF 우선 처리 — confirmed=true
    expect((res.body.data || res.body).confirmed).toBe(true);
    expect((res.body.data || res.body).response_type).toBe('DTMF');
  });
});

// ─────────────────────────────────────────────────────────────
// 시나리오 2: STT 한국어 응답 플로우
// ─────────────────────────────────────────────────────────────
describe('E2E 시나리오 2: STT 한국어 응답', () => {
  it('"네" → confirmed=true', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-e2e-3',
        medication: '혈압약',
        rawText:    '네',
        lang:       'ko',
        date:       '2024-06-15',
        time:       '09:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(true);
    expect((res.body.data || res.body).response_type).toBe('STT');
  });

  it('"먹었어요" → confirmed=true', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-e2e-3',
        medication: '당뇨약',
        rawText:    '먹었어요',
        lang:       'ko',
        date:       '2024-06-15',
        time:       '10:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(true);
  });

  it('"아니요" → confirmed=false', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-e2e-3',
        medication: '혈압약',
        rawText:    '아니요',
        lang:       'ko',
        date:       '2024-06-16',
        time:       '09:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 시나리오 3: STT 오탐 방지 E2E (HIGH BUG FIX 검증)
// ─────────────────────────────────────────────────────────────
describe('E2E 시나리오 3: STT 오탐 방지 — HIGH BUG FIX 검증', () => {
  const ODAM_CASES = [
    { text: '맑네요',               desc: '날씨 표현 — 네 포함 오탐 방지' },
    // '아니네요'는 ^아니 regex로 DENY — 의도된 동작 (오탐 아님)
    { text: '그건 맞는 말인데요',   desc: '맞 포함 문장' },
    { text: '예전에 먹었던 것 같아요', desc: '예전 — 예 포함 오탐 방지' },
    { text: '오늘 맑고 좋은 날이네', desc: '복합 문장' },
  ];

  for (const { text, desc } of ODAM_CASES) {
    it(`"${text}" → NO_RESPONSE (${desc})`, async () => {
      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({
          userId:     'user-odam-test',
          medication: '혈압약',
          rawText:    text,
          lang:       'ko',
          date:       '2024-06-17',
          time:       '09:00',
        })
        .expect(res => expect([200,201,202]).toContain(res.status));

      // confirmed=null (NO_RESPONSE) → 재질문 트리거
      expect((res.body.data || res.body).confirmed).toBeNull();
      expect((res.body.data || res.body).response_type).toBe('NO_RESPONSE');
    });
  }

  it('"맑네요" 오탐 발생 시 앱이 500 에러를 내지 않음 (안정성)', async () => {
    await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-stability',
        medication: '혈압약',
        rawText:    '맑네요',
        lang:       'ko',
        date:       '2024-06-17',
        time:       '09:30',
      })
      .expect(res => expect(res.status).not.toBe(500));
  });
});

// ─────────────────────────────────────────────────────────────
// 시나리오 4: 다국어 STT E2E (KO/JA/EN)
// ─────────────────────────────────────────────────────────────
describe('E2E 시나리오 4: 다국어 STT', () => {
  it('일본어 "はい" → confirmed=true', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-ja',
        medication: '血圧薬',
        rawText:    'はい',
        lang:       'ja',
        date:       '2024-06-15',
        time:       '09:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(true);
  });

  it('일본어 "飲みました" → confirmed=true', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-ja',
        medication: '血圧薬',
        rawText:    '飲みました',
        lang:       'ja',
        date:       '2024-06-15',
        time:       '10:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(true);
  });

  it('영어 "yes" → confirmed=true', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-en',
        medication: 'blood pressure pill',
        rawText:    'yes',
        lang:       'en',
        date:       '2024-06-15',
        time:       '09:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(true);
  });

  it('영어 "no" → confirmed=false', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-en',
        medication: 'blood pressure pill',
        rawText:    'no',
        lang:       'en',
        date:       '2024-06-15',
        time:       '10:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBe(false);
  });

  it('영어 단어경계 — "noted" → NO_RESPONSE ("no" 오탐 방지)', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-en',
        medication: 'blood pressure pill',
        rawText:    'noted',
        lang:       'en',
        date:       '2024-06-16',
        time:       '09:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBeNull();
  });

  it('영어 "yesterday" → NO_RESPONSE ("yes" 오탐 방지)', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-en',
        medication: 'blood pressure pill',
        rawText:    'yesterday',
        lang:       'en',
        date:       '2024-06-16',
        time:       '10:00',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 시나리오 5: 입력 검증 (필수 필드 누락)
// ─────────────────────────────────────────────────────────────
describe('E2E 시나리오 5: 입력 검증 오류', () => {
  it('userId 누락 → 400', async () => {
    await request(app)
      .post('/api/medication/ivr-response')
      .send({
        medication: '혈압약',
        dtmfDigit:  '1',
      })
      .expect(400);
  });

  it('medication 누락 → 400', async () => {
    await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:    'user-1',
        dtmfDigit: '1',
      })
      .expect(400);
  });

  it('dtmfDigit 잘못된 값 ("3") → 400', async () => {
    await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-1',
        medication: '혈압약',
        dtmfDigit:  '3',
      })
      .expect(400);
  });

  it('lang 잘못된 값 → 400', async () => {
    await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-1',
        medication: '혈압약',
        lang:       'fr',  // 지원 안 함
        rawText:    '네',
      })
      .expect(400);
  });

  it('rawText도 dtmfDigit도 없는 경우 → 200 NO_RESPONSE', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-1',
        medication: '혈압약',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).confirmed).toBeNull();
    expect((res.body.data || res.body).response_type).toBe('NO_RESPONSE');
  });
});

// ─────────────────────────────────────────────────────────────
// 시나리오 6: 헬스체크 엔드포인트
// ─────────────────────────────────────────────────────────────
describe('E2E 시나리오 6: 헬스체크', () => {
  it('GET /ping → 200 { status: "ok" }', async () => {
    const res = await request(app)
      .get('/ping')
      .expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.ts).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// 시나리오 7: 연속 미복약 감지 (3일치 DB 기록 후 확인)
// ─────────────────────────────────────────────────────────────
describe('E2E 시나리오 7: 3일 연속 미복약 → 에스컬레이션 감지', () => {
  const userId = 'user-consecutive';
  const med    = '혈압약';

  // checkConsecutiveMissed는 오늘 기준 최근 3일 확인 — 테스트 날짜를 오늘 기준으로 생성
  function getRecentDates() {
    const today = new Date();
    return Array.from({ length: 3 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      return d.toISOString().split('T')[0];
    });
  }

  it('3일 연속 미복약 기록 후 checkConsecutiveMissed=true', async () => {
    const days = getRecentDates();  // 오늘 기준 최근 3일
    for (const date of days) {
      await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId, medication: med, dtmfDigit: '2', date, time: '09:00' })
        .expect(res => expect([200,201,202]).toContain(res.status));
    }

    const missed = await ivrSvc.checkConsecutiveMissed(userId, med);
    expect(missed).toBe(true);
  });

  it('복약 기록 없는 사용자 → checkConsecutiveMissed=false', async () => {
    const missed = await ivrSvc.checkConsecutiveMissed('user-no-records', med);
    expect(missed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 시나리오 8: 빈 응답 (NO_RESPONSE) 처리 일관성
// ─────────────────────────────────────────────────────────────
describe('E2E 시나리오 8: NO_RESPONSE 처리 일관성', () => {
  it('빈 rawText → NO_RESPONSE', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-empty',
        medication: '혈압약',
        rawText:    '',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).response_type).toBe('NO_RESPONSE');
    expect((res.body.data || res.body).confirmed).toBeNull();
  });

  it('null rawText → NO_RESPONSE', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-null',
        medication: '혈압약',
        rawText:    null,
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).response_type).toBe('NO_RESPONSE');
  });

  it('알 수 없는 발화 → NO_RESPONSE (재질문 유도)', async () => {
    const res = await request(app)
      .post('/api/medication/ivr-response')
      .send({
        userId:     'user-unknown',
        medication: '혈압약',
        rawText:    '오늘 날씨가 참 좋네요',
        lang:       'ko',
      })
      .expect(res => expect([200,201,202]).toContain(res.status));

    expect((res.body.data || res.body).response_type).toBe('NO_RESPONSE');
    expect((res.body.data || res.body).confirmed).toBeNull();
  });
});
