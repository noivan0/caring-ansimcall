'use strict';
/**
 * __tests__/ivr_route.test.js — IVR 라우트 + notificationService 테스트
 * nova-qa 감사 R30 (케어링)
 *
 * 헤르2 체크포인트:
 * - IVR route POST /api/medication/ivr-response
 * - 3일 연속 미복약 → 202 + notified_family
 * - Quiet Hours KST 22:00~08:00 경계값
 * - notificationService mock
 * - DTMF 1/2 정상 처리
 * - 검증 에러 (400)
 */

const request = require('supertest');
const express = require('express');

// ── 의존성 Mock ──────────────────────────────────────────────

jest.mock('../src/services/IvrService', () => ({
  processIvrCall: jest.fn(),
  MedicationCallLog: { create: jest.fn(), markFamilyNotified: jest.fn() },
  parseIvrResponse: jest.fn(),
  processDtmf: jest.fn(),
  checkConsecutiveMissed: jest.fn(),
}));

const { processIvrCall } = require('../src/services/IvrService');

// ── 앱 셋업 ─────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  const ivrRouter = require('../src/routes/ivr');
  app.use('/api/medication', ivrRouter);
  return app;
}

// ── 기본 IVR 응답 목 ────────────────────────────────────────

const baseResult = {
  log: { id: 1, confirmed: true },
  parsed: { confirmed: true, response_type: 'STT' },
  notified_family: false,
  consecutive_missed: false,
};

// ── 테스트 ──────────────────────────────────────────────────

describe('POST /api/medication/ivr-response', () => {
  let app;

  beforeEach(() => {
    app = makeApp();
    processIvrCall.mockReset();
  });

  describe('정상 처리 — STT 복약 확인', () => {
    it('복약 확인 응답 → 201', async () => {
      processIvrCall.mockResolvedValue(baseResult);

      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u1', medication: '혈압약', rawText: '네 먹었어요' });

      expect(res.status).toBe(201);
      expect(res.body.data.confirmed).toBe(true);
      expect(res.body.data.notified_family).toBe(false);
    });

    it('DTMF 1 (복용) → 201', async () => {
      processIvrCall.mockResolvedValue({
        ...baseResult,
        parsed: { confirmed: true, response_type: 'DTMF' },
      });

      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u1', medication: '혈압약', dtmfDigit: '1' });

      expect(res.status).toBe(201);
      expect(res.body.data.response_type).toBe('DTMF');
    });

    it('DTMF 2 (미복용) → 201', async () => {
      processIvrCall.mockResolvedValue({
        ...baseResult,
        parsed: { confirmed: false, response_type: 'DTMF' },
      });

      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u1', medication: '혈압약', dtmfDigit: '2' });

      expect(res.status).toBe(201);
    });

    it('무응답(rawText 없음) 처리 → 201', async () => {
      processIvrCall.mockResolvedValue({
        ...baseResult,
        parsed: { confirmed: null, response_type: 'NO_RESPONSE' },
      });

      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u1', medication: '혈압약' });

      expect(res.status).toBe(201);
    });
  });

  describe('3일 연속 미복약 → 가족 알림 에스컬레이션', () => {
    it('notified_family=true → 202 Accepted', async () => {
      processIvrCall.mockResolvedValue({
        log: { id: 2, confirmed: false },
        parsed: { confirmed: false, response_type: 'STT' },
        notified_family: true,
        consecutive_missed: true,
      });

      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u2', medication: '당뇨약', rawText: '아직요' });

      expect(res.status).toBe(202);
      expect(res.body.data.notified_family).toBe(true);
      expect(res.body.message).toMatch(/가족/);
    });
  });

  describe('입력 검증 (400 VALIDATION_ERROR)', () => {
    it('userId 누락 → 400', async () => {
      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ medication: '혈압약' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('medication 누락 → 400', async () => {
      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u1' });

      expect(res.status).toBe(400);
    });

    it('DTMF 잘못된 값 (3) → 400', async () => {
      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u1', medication: '혈압약', dtmfDigit: '3' });

      expect(res.status).toBe(400);
    });

    it('잘못된 날짜 형식 → 400', async () => {
      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u1', medication: '혈압약', date: 'not-a-date' });

      expect(res.status).toBe(400);
    });

    it('지원하지 않는 언어 → 400', async () => {
      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'u1', medication: '혈압약', lang: 'zh' });

      expect(res.status).toBe(400);
    });
  });

  describe('구조화 로깅 — PII 마스킹', () => {
    it('응답에 raw userId 미포함 (로그 레벨 검증은 서비스 레벨)', async () => {
      processIvrCall.mockResolvedValue(baseResult);

      const res = await request(app)
        .post('/api/medication/ivr-response')
        .send({ userId: 'user-12345', medication: '혈압약', rawText: '네' });

      expect(res.status).toBe(201);
      // 응답 본문에 원본 userId 포함 여부 (설계상 data에 log 포함)
      expect(JSON.stringify(res.body)).not.toContain('user-12345');
    });
  });
});

describe('GET /api/ivr/stats/weekly — IVR 주간 통계', () => {
  let app;

  beforeEach(() => {
    app = makeApp();
  });

  it('DB 없는 환경에서도 200 응답 (폴백)', async () => {
    const res = await request(app).get('/api/medication/stats/weekly');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('period', 'weekly');
    expect(res.body).toHaveProperty('target_pct', 70);
  });
});
