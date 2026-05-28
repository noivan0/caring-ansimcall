/**
 * tests/health.test.js — 건강 데이터 CRUD + 헬스체크 + 복약 알림 로직 테스트
 *
 * 커버:
 *   GET  /health           — 서버 헬스체크 (db/redis/version)
 *   GET  /api/v1/health/elder/:elderId          — 건강 요약
 *   POST /api/v1/health/elder/:elderId/vitals   — 바이탈 기록
 *   GET  /api/v1/health/elder/:elderId/history  — 기간별 이력
 *   PUT  /api/v1/health/elder/:elderId/thresholds — 임계값 설정
 *   복약 알림 크론 로직 (sendDueReminders / checkMissedMedications)
 */

'use strict';

// ── Mock 등록 (testApp.js가 수행, 여기서는 추가 mock만) ──────
jest.mock('../src/models/user', () => {
  const fn = jest.fn();
  return {
    User: {
      findById: fn,
      findByEmail: jest.fn(),
      create: jest.fn(),
      verifyPassword: jest.fn(),
      anonymize: jest.fn(),
    },
    Elder: { findById: fn, getFcmToken: jest.fn() },
    Guardian: {},
  };
});

jest.mock('../src/services/notificationService', () => ({
  notifyGuardians: jest.fn().mockResolvedValue(undefined),
  notifyUser:      jest.fn().mockResolvedValue(undefined),
  sendFcmMessage:  jest.fn().mockResolvedValue('mock-msg-id'),
}));

const request = require('supertest');
const app     = require('./testApp');
const { makeToken, UUIDS, mockDbQuerySequence, fakeUser, fakeElder } = require('./fixtures');
const { User } = require('../src/models/user');
const db        = require('../src/models/db');
const { notifyGuardians, sendFcmMessage } = require('../src/services/notificationService');

// ────────────────────────────────────────────────────────────────
// GET /health — 서버 헬스체크
// ────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  beforeEach(() => {
    db.pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 });
  });

  it('db+redis 정상 → 200 + status:ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      db:    'ok',
      redis: 'ok',
    });
    expect(res.body.version).toBeDefined();
  });

  it('db 오류 → 503 + status:degraded', async () => {
    db.pool.query.mockRejectedValueOnce(new Error('DB 연결 실패'));
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('error');
  });
});

// ────────────────────────────────────────────────────────────────
// 인증 미들웨어 통과를 위한 공통 설정
// ────────────────────────────────────────────────────────────────

function setupAuth(role = 'guardian') {
  const user = fakeUser({ role });
  User.findById.mockResolvedValue(user);
  return { user, token: makeToken(role, user.id) };
}

function setupGuardianRelationship() {
  // guardian_relationships 레코드 mock (checkRelationship에서 사용)
  db.query.mockResolvedValueOnce({
    rows: [{ id: 'rel-1' }],
    rowCount: 1,
  });
}

// ────────────────────────────────────────────────────────────────
// GET /api/v1/health/elder/:elderId — 건강 요약
// ────────────────────────────────────────────────────────────────

describe('GET /api/v1/health/elder/:elderId', () => {
  const elderId = UUIDS.elder1;

  it('인증 없이 → 401', async () => {
    const res = await request(app).get(`/api/v1/health/elder/${elderId}`);
    expect(res.status).toBe(401);
  });

  it('보호자 인증 + 데이터 있음 → 200', async () => {
    const { token } = setupAuth('guardian');
    // 1) checkRelationship: guardian_relationships 조회
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })   // relationship check
      .mockResolvedValueOnce({                                              // 건강 요약 쿼리
        rows: [{
          id: elderId,
          display_name: '테스트노인',
          latest_vitals: { heart_rate: 72, blood_pressure_systolic: 120 },
          meds_taken_today: 1,
          meds_scheduled_today: 2,
          last_location: null,
        }],
        rowCount: 1,
      });

    const res = await request(app)
      .get(`/api/v1/health/elder/${elderId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: elderId });
  });

  it('노인 존재하지 않음 → 404', async () => {
    const { token } = setupAuth('guardian');
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get(`/api/v1/health/elder/${elderId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ELDER_NOT_FOUND');
  });

  it('잘못된 elderId (UUID 아님) → 400', async () => {
    const { token } = setupAuth('guardian');
    const res = await request(app)
      .get('/api/v1/health/elder/not-a-uuid')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('관계 없는 보호자 → 403', async () => {
    const { token } = setupAuth('guardian');
    // guardian_relationships: 빈 결과
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get(`/api/v1/health/elder/${elderId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NO_RELATIONSHIP');
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/v1/health/elder/:elderId/vitals — 바이탈 기록
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/health/elder/:elderId/vitals', () => {
  const elderId = UUIDS.elder1;

  it('정상 바이탈 기록 → 201', async () => {
    const { token } = setupAuth('guardian');
    const vital = {
      elder_id: elderId,
      blood_pressure_systolic: 120,
      blood_pressure_diastolic: 80,
      heart_rate: 72,
      source: 'smartwatch',
    };

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })  // relationship
      .mockResolvedValueOnce({ rows: [vital], rowCount: 1 })              // INSERT vitals
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                  // threshold check

    const res = await request(app)
      .post(`/api/v1/health/elder/${elderId}/vitals`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        blood_pressure_systolic: 120,
        blood_pressure_diastolic: 80,
        heart_rate: 72,
        source: 'smartwatch',
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
  });

  it('source 누락 → 400 VALIDATION_ERROR', async () => {
    const { token } = setupAuth('guardian');
    const res = await request(app)
      .post(`/api/v1/health/elder/${elderId}/vitals`)
      .set('Authorization', `Bearer ${token}`)
      .send({ heart_rate: 72 }); // source 없음

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('blood_pressure_systolic 범위 초과 → 400', async () => {
    const { token } = setupAuth('guardian');
    const res = await request(app)
      .post(`/api/v1/health/elder/${elderId}/vitals`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blood_pressure_systolic: 999, source: 'manual' });

    expect(res.status).toBe(400);
  });

  it('임계값 초과 시 보호자 알림 호출', async () => {
    const { token } = setupAuth('guardian');
    const vital = {
      elder_id: elderId,
      blood_pressure_systolic: 200, // 임계값 초과
      heart_rate: 72,
      source: 'manual',
    };

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [vital], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ settings: { blood_pressure_systolic_max: 160 } }],
        rowCount: 1,
      });

    notifyGuardians.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post(`/api/v1/health/elder/${elderId}/vitals`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blood_pressure_systolic: 200, source: 'manual' });

    expect(res.status).toBe(201);
    // 임계값 알림은 비동기(catch) — 100ms 대기
    await new Promise(r => setTimeout(r, 100));
    expect(notifyGuardians).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// GET /api/v1/health/elder/:elderId/history — 기간별 이력
// ────────────────────────────────────────────────────────────────

describe('GET /api/v1/health/elder/:elderId/history', () => {
  const elderId = UUIDS.elder1;

  it('이력 조회 → 200 + count', async () => {
    const { token } = setupAuth('guardian');
    const fakeRows = [
      { heart_rate: 70, recorded_at: '2024-01-01T08:00:00Z' },
      { heart_rate: 75, recorded_at: '2024-01-02T08:00:00Z' },
    ];

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: fakeRows, rowCount: 2 });

    const res = await request(app)
      .get(`/api/v1/health/elder/${elderId}/history?limit=10`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.count).toBe(2);
  });

  it('limit 범위 초과(1001) → 400', async () => {
    const { token } = setupAuth('guardian');
    const res = await request(app)
      .get(`/api/v1/health/elder/${elderId}/history?limit=1001`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// PUT /api/v1/health/elder/:elderId/thresholds — 임계값 설정
// ────────────────────────────────────────────────────────────────

describe('PUT /api/v1/health/elder/:elderId/thresholds', () => {
  const elderId = UUIDS.elder1;

  it('보호자가 임계값 설정 → 200', async () => {
    const { token } = setupAuth('guardian');
    const thData = { elder_id: elderId, settings: { blood_pressure_systolic_max: 160 } };

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [thData], rowCount: 1 });

    const res = await request(app)
      .put(`/api/v1/health/elder/${elderId}/thresholds`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blood_pressure_systolic_max: 160, heart_rate_max: 100 });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it('elder 역할로 임계값 설정 시도 → 403', async () => {
    const { token } = setupAuth('elder');
    const res = await request(app)
      .put(`/api/v1/health/elder/${elderId}/thresholds`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blood_pressure_systolic_max: 160 });
    expect(res.status).toBe(403);
  });
});

// ────────────────────────────────────────────────────────────────
// 복약 알림 크론 로직 (unit test — DB mock 직접 주입)
// ────────────────────────────────────────────────────────────────

describe('복약 알림 크론 로직', () => {
  let sendDueReminders, checkMissedMedications;

  beforeAll(() => {
    ({ sendDueReminders, checkMissedMedications } =
      require('../src/cron/medication_reminder'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('이 시각 복약 스케줄이 없으면 알림 미발송', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await sendDueReminders();

    expect(sendFcmMessage).not.toHaveBeenCalled();
  });

  it('이 시각 복약 스케줄 존재 + 미복약 → FCM 발송', async () => {
    const schedule = {
      schedule_id:      UUIDS.sched1,
      elder_id:         UUIDS.elder1,
      medication_name:  '혈압약',
      dosage:           '1정',
      elder_user_id:    UUIDS.elder1 + '-u',
      elder_fcm_token:  'fcm-token-test',
      elder_name:       '테스트노인',
    };

    db.query
      .mockResolvedValueOnce({ rows: [schedule], rowCount: 1 })  // 스케줄 조회
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })           // alreadyTaken 체크
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });          // reminder_log INSERT

    await sendDueReminders();

    expect(sendFcmMessage).toHaveBeenCalledWith(
      'fcm-token-test',
      expect.objectContaining({ title: '복약 시간입니다' }),
      expect.any(Object)
    );
  });

  it('이미 복약한 스케줄 → FCM 미발송', async () => {
    const schedule = {
      schedule_id: UUIDS.sched1,
      elder_id:    UUIDS.elder1,
      medication_name: '혈압약',
      dosage: '1정',
      elder_fcm_token: 'fcm-token-test',
      elder_name: '테스트노인',
    };

    db.query
      .mockResolvedValueOnce({ rows: [schedule], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'log-1' }], rowCount: 1 }); // already taken

    await sendDueReminders();

    expect(sendFcmMessage).not.toHaveBeenCalled();
  });

  it('3회 연속 미복약 → 보호자 에스컬레이션 알림', async () => {
    const missed = {
      schedule_id:     UUIDS.sched1,
      elder_id:        UUIDS.elder1,
      medication_name: '혈압약',
      dosage:          '1정',
      taken_today:     0,
    };

    db.query
      .mockResolvedValueOnce({ rows: [missed], rowCount: 1 })     // missed schedules
      .mockResolvedValueOnce({ rows: [{ cnt: '3' }], rowCount: 1 }) // missedCount
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });            // INSERT missed log

    await checkMissedMedications();

    expect(notifyGuardians).toHaveBeenCalledWith(
      UUIDS.elder1,
      expect.objectContaining({ type: 'MEDICATION_ESCALATION', missedCount: 3 }),
      expect.objectContaining({ highPriority: true })
    );
  });

  it('1회 미복약 → 보호자 일반 알림', async () => {
    const missed = {
      schedule_id:     UUIDS.sched1,
      elder_id:        UUIDS.elder1,
      medication_name: '혈압약',
      dosage:          '1정',
      taken_today:     0,
    };

    db.query
      .mockResolvedValueOnce({ rows: [missed], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ cnt: '1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await checkMissedMedications();

    expect(notifyGuardians).toHaveBeenCalledWith(
      UUIDS.elder1,
      expect.objectContaining({ type: 'MEDICATION_MISSED' })
    );
  });
});
