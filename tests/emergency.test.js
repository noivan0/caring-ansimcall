/**
 * tests/emergency.test.js — 응급 버튼 + 에스컬레이션 로직 테스트
 *
 * 커버:
 *   POST /api/v1/emergency/elder/:elderId/sos     — SOS 트리거 + 119 연동 + Socket.IO
 *   GET  /api/v1/emergency/elder/:elderId/history — 응급 이력
 *   POST /api/v1/emergency/elder/:elderId/resolve — 응급 해제
 *   에스컬레이션: 보호자 전원 동시 알림, Socket.IO emit
 */

'use strict';

jest.mock('../src/models/user', () => {
  const fn = jest.fn();
  return {
    User:     { findById: fn, findByEmail: jest.fn(), create: jest.fn(), verifyPassword: jest.fn(), anonymize: jest.fn() },
    Elder:    { findById: fn, getFcmToken: jest.fn() },
    Guardian: {},
  };
});

jest.mock('../src/services/notificationService', () => ({
  notifyGuardians: jest.fn().mockResolvedValue(undefined),
  notifyUser:      jest.fn().mockResolvedValue(undefined),
  sendFcmMessage:  jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/emergencyService', () => ({
  trigger119: jest.fn().mockResolvedValue({ success: false, reason: 'NO_API_KEY' }),
}));

const request = require('supertest');
const app     = require('./testApp');
const { makeToken, UUIDS, fakeUser } = require('./fixtures');
const { User }          = require('../src/models/user');
const db                = require('../src/models/db');
const { notifyGuardians } = require('../src/services/notificationService');

// ── 공통 헬퍼 ──────────────────────────────────────────────────

function setupAuth(role = 'guardian') {
  const user = fakeUser({ role });
  User.findById.mockResolvedValue(user);
  return { user, token: makeToken(role, user.id) };
}

const elderId = UUIDS.elder1;
const eventId = UUIDS.event1;

// ────────────────────────────────────────────────────────────────
// POST /api/v1/emergency/elder/:elderId/sos — SOS 트리거
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/emergency/elder/:elderId/sos', () => {
  it('인증 없이 → 401', async () => {
    const res = await request(app)
      .post(`/api/v1/emergency/elder/${elderId}/sos`)
      .send({ trigger_type: 'button' });
    expect(res.status).toBe(401);
  });

  it('SOS 트리거 (좌표 포함) → 201 + notifyGuardians 호출', async () => {
    const { token } = setupAuth('elder');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: elderId }], rowCount: 1 })  // elder check
      .mockResolvedValueOnce({                                             // INSERT emergency_events
        rows: [{
          id: eventId,
          elder_id: elderId,
          trigger_type: 'button',
          latitude: 37.5759,
          longitude: 126.9769,
          status: 'active',
          triggered_at: new Date().toISOString(),
        }],
        rowCount: 1,
      });

    const res = await request(app)
      .post(`/api/v1/emergency/elder/${elderId}/sos`)
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: 37.5759, longitude: 126.9769, trigger_type: 'button' });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('active');
    expect(notifyGuardians).toHaveBeenCalledWith(
      elderId,
      expect.objectContaining({ type: 'SOS_TRIGGERED' })
    );
  });

  it('SOS 트리거 (좌표 없음) → 201', async () => {
    const { token } = setupAuth('elder');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: elderId }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: eventId, elder_id: elderId, status: 'active', triggered_at: new Date().toISOString() }],
        rowCount: 1,
      });

    const res = await request(app)
      .post(`/api/v1/emergency/elder/${elderId}/sos`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trigger_type: 'fall_detect' });

    expect(res.status).toBe(201);
  });

  it('Socket.IO guardian 룸으로 emit 호출', async () => {
    const { token } = setupAuth('guardian');
    const mockEmit = jest.fn();
    const mockTo = jest.spyOn(app.get('io'), 'to').mockReturnValue({ emit: mockEmit });

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: eventId, elder_id: elderId, status: 'active', triggered_at: new Date().toISOString() }],
        rowCount: 1,
      });

    await request(app)
      .post(`/api/v1/emergency/elder/${elderId}/sos`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trigger_type: 'button' });

    expect(mockTo).toHaveBeenCalledWith(`guardian:${elderId}`);
    expect(mockEmit).toHaveBeenCalledWith('sos:triggered', expect.any(Object));
    mockTo.mockRestore();
  });

  it('잘못된 elderId (UUID 아님) → 400', async () => {
    const { token } = setupAuth('elder');
    const res = await request(app)
      .post('/api/v1/emergency/elder/not-a-uuid/sos')
      .set('Authorization', `Bearer ${token}`)
      .send({ trigger_type: 'button' });
    expect(res.status).toBe(400);
  });

  it('관계 없는 보호자 → 403', async () => {
    const { token } = setupAuth('guardian');
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no relationship

    const res = await request(app)
      .post(`/api/v1/emergency/elder/${elderId}/sos`)
      .set('Authorization', `Bearer ${token}`)
      .send({ trigger_type: 'button' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NO_RELATIONSHIP');
  });
});

// ────────────────────────────────────────────────────────────────
// GET /api/v1/emergency/elder/:elderId/history — 응급 이력
// ────────────────────────────────────────────────────────────────

describe('GET /api/v1/emergency/elder/:elderId/history', () => {
  it('이력 조회 → 200', async () => {
    const { token } = setupAuth('guardian');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { id: eventId, status: 'resolved', triggered_at: '2024-01-01T10:00:00Z', responder_name: '보호자A' },
          { id: 'ev-2',  status: 'active',   triggered_at: '2024-01-02T08:00:00Z', responder_name: null },
        ],
        rowCount: 2,
      });

    const res = await request(app)
      .get(`/api/v1/emergency/elder/${elderId}/history`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].status).toBe('resolved');
  });

  it('인증 없이 → 401', async () => {
    const res = await request(app).get(`/api/v1/emergency/elder/${elderId}/history`);
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/v1/emergency/elder/:elderId/resolve — 응급 해제
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/emergency/elder/:elderId/resolve', () => {
  it('응급 해제 → 200 + Socket.IO emit', async () => {
    const { user, token } = setupAuth('guardian');
    const mockEmit = jest.fn();
    const mockTo = jest.spyOn(app.get('io'), 'to').mockReturnValue({ emit: mockEmit });

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: eventId,
          elder_id: elderId,
          status: 'resolved',
          resolved_by: user.id,
          resolved_at: new Date().toISOString(),
        }],
        rowCount: 1,
      });

    const res = await request(app)
      .post(`/api/v1/emergency/elder/${elderId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ event_id: eventId, note: '가족이 현장 도착, 안전 확인' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('resolved');
    expect(mockTo).toHaveBeenCalledWith(`guardian:${elderId}`);
    expect(mockEmit).toHaveBeenCalledWith('sos:resolved', expect.any(Object));
    mockTo.mockRestore();
  });

  it('존재하지 않는 event_id → 404', async () => {
    const { token } = setupAuth('guardian');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // event not found

    const res = await request(app)
      .post(`/api/v1/emergency/elder/${elderId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ event_id: eventId });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('EVENT_NOT_FOUND');
  });

  it('event_id 없으면 → 400', async () => {
    const { token } = setupAuth('guardian');
    const res = await request(app)
      .post(`/api/v1/emergency/elder/${elderId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: '해제 노트만' }); // event_id 없음

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
