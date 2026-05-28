/**
 * tests/location.test.js — 위치 공유 + 안전구역 이탈 감지 테스트
 *
 * 커버:
 *   POST   /api/v1/location/elder/:elderId           — 위치 업데이트
 *   GET    /api/v1/location/elder/:elderId/current   — 현재 위치
 *   GET    /api/v1/location/elder/:elderId/history   — 이동 이력
 *   POST   /api/v1/location/elder/:elderId/safe-zones — 안전구역 등록
 *   GET    /api/v1/location/elder/:elderId/safe-zones — 안전구역 목록
 *   DELETE /api/v1/location/elder/:elderId/safe-zones/:zoneId — 삭제
 *   안전구역 이탈 감지 시 보호자 알림 트리거
 */

'use strict';

jest.mock('../src/models/user', () => {
  const fn = jest.fn();
  return {
    User:     { findById: fn, findByEmail: jest.fn(), create: jest.fn(), verifyPassword: jest.fn(), anonymize: jest.fn() },
    Elder:    { findById: fn },
    Guardian: {},
  };
});

jest.mock('../src/services/notificationService', () => ({
  notifyGuardians: jest.fn().mockResolvedValue(undefined),
  notifyUser:      jest.fn().mockResolvedValue(undefined),
  sendFcmMessage:  jest.fn().mockResolvedValue(undefined),
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

const elderId  = UUIDS.elder1;
const zoneId   = UUIDS.zone1;

// 서울 광화문 좌표 (대한민국 범위 내)
const VALID_LAT = 37.5759;
const VALID_LNG = 126.9769;

// ────────────────────────────────────────────────────────────────
// POST /api/v1/location/elder/:elderId — 위치 업데이트
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/location/elder/:elderId', () => {
  const payload = { latitude: VALID_LAT, longitude: VALID_LNG };

  it('인증 없이 → 401', async () => {
    const res = await request(app).post(`/api/v1/location/elder/${elderId}`).send(payload);
    expect(res.status).toBe(401);
  });

  it('정상 위치 업데이트 (안전구역 내) → 201', async () => {
    const { token } = setupAuth('elder');
    // elder 역할: checkRelationship에서 elders 테이블 조회
    db.query
      .mockResolvedValueOnce({ rows: [{ id: elderId }], rowCount: 1 })  // elders table check
      .mockResolvedValueOnce({                                             // safe_zones check
        rows: [{ id: zoneId, name: '집', is_inside: true }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({                                             // location_logs INSERT
        rows: [{ id: 'loc-1', elder_id: elderId, latitude: VALID_LAT, longitude: VALID_LNG, is_in_safe_zone: true }],
        rowCount: 1,
      });

    const res = await request(app)
      .post(`/api/v1/location/elder/${elderId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.isInSafeZone).toBe(true);
  });

  it('안전구역 이탈 → 201 + notifyGuardians 호출', async () => {
    const { token } = setupAuth('elder');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: elderId }], rowCount: 1 }) // elder check
      .mockResolvedValueOnce({                                            // safe_zones: 이탈
        rows: [{ id: zoneId, name: '집', is_inside: false }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({                                            // INSERT
        rows: [{ id: 'loc-2', is_in_safe_zone: false }],
        rowCount: 1,
      });

    const res = await request(app)
      .post(`/api/v1/location/elder/${elderId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.isInSafeZone).toBe(false);

    // notifyGuardians는 비동기 — 100ms 대기
    await new Promise(r => setTimeout(r, 100));
    expect(notifyGuardians).toHaveBeenCalledWith(
      elderId,
      expect.objectContaining({ type: 'SAFE_ZONE_EXIT', zoneName: '집' })
    );
  });

  it('대한민국 범위 외 좌표 → 400', async () => {
    const { token } = setupAuth('elder');
    const res = await request(app)
      .post(`/api/v1/location/elder/${elderId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: 10.0, longitude: 100.0 }); // 태국 근처
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('latitude 누락 → 400', async () => {
    const { token } = setupAuth('elder');
    const res = await request(app)
      .post(`/api/v1/location/elder/${elderId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ longitude: VALID_LNG });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// GET /api/v1/location/elder/:elderId/current — 현재 위치
// ────────────────────────────────────────────────────────────────

describe('GET /api/v1/location/elder/:elderId/current', () => {
  it('현재 위치 조회 → 200', async () => {
    const { token } = setupAuth('guardian');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'loc-1', latitude: VALID_LAT, longitude: VALID_LNG, elder_name: '테스트노인' }],
        rowCount: 1,
      });

    const res = await request(app)
      .get(`/api/v1/location/elder/${elderId}/current`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.latitude).toBe(VALID_LAT);
  });

  it('위치 데이터 없음 → 404', async () => {
    const { token } = setupAuth('guardian');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get(`/api/v1/location/elder/${elderId}/current`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NO_LOCATION_DATA');
  });
});

// ────────────────────────────────────────────────────────────────
// GET /api/v1/location/elder/:elderId/history — 이동 이력
// ────────────────────────────────────────────────────────────────

describe('GET /api/v1/location/elder/:elderId/history', () => {
  it('이력 조회 → 200 + count', async () => {
    const { token } = setupAuth('guardian');
    const rows = [
      { latitude: 37.57, longitude: 126.97, recorded_at: '2024-01-01T08:00:00Z' },
      { latitude: 37.58, longitude: 126.98, recorded_at: '2024-01-01T09:00:00Z' },
    ];

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows, rowCount: 2 });

    const res = await request(app)
      .get(`/api/v1/location/elder/${elderId}/history?limit=10`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.count).toBe(2);
  });

  it('limit 초과(501) → 400', async () => {
    const { token } = setupAuth('guardian');
    const res = await request(app)
      .get(`/api/v1/location/elder/${elderId}/history?limit=501`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/v1/location/elder/:elderId/safe-zones — 안전구역 등록
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/location/elder/:elderId/safe-zones', () => {
  const zonePayload = {
    name: '우리집',
    latitude: VALID_LAT,
    longitude: VALID_LNG,
    radius_meters: 200,
    icon: 'home',
  };

  it('보호자가 안전구역 등록 → 201', async () => {
    const { token } = setupAuth('guardian');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: zoneId, name: '우리집', radius_meters: 200, icon: 'home', is_active: true }],
        rowCount: 1,
      });

    const res = await request(app)
      .post(`/api/v1/location/elder/${elderId}/safe-zones`)
      .set('Authorization', `Bearer ${token}`)
      .send(zonePayload);

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('우리집');
  });

  it('노인이 안전구역 등록 시도 → 403 (requireRole guardian)', async () => {
    const { token } = setupAuth('elder');
    const res = await request(app)
      .post(`/api/v1/location/elder/${elderId}/safe-zones`)
      .set('Authorization', `Bearer ${token}`)
      .send(zonePayload);
    expect(res.status).toBe(403);
  });

  it('radius_meters 범위 초과(5001) → 400', async () => {
    const { token } = setupAuth('guardian');
    const res = await request(app)
      .post(`/api/v1/location/elder/${elderId}/safe-zones`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...zonePayload, radius_meters: 5001 });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// GET /api/v1/location/elder/:elderId/safe-zones — 목록
// ────────────────────────────────────────────────────────────────

describe('GET /api/v1/location/elder/:elderId/safe-zones', () => {
  it('안전구역 목록 조회 → 200', async () => {
    const { token } = setupAuth('guardian');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { id: zoneId, name: '우리집', latitude: VALID_LAT, longitude: VALID_LNG },
        ],
        rowCount: 1,
      });

    const res = await request(app)
      .get(`/api/v1/location/elder/${elderId}/safe-zones`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// DELETE /api/v1/location/elder/:elderId/safe-zones/:zoneId — 삭제
// ────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/location/elder/:elderId/safe-zones/:zoneId', () => {
  it('안전구역 삭제 (soft delete) → 204', async () => {
    const { token } = setupAuth('guardian');

    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'rel-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE is_active=false

    const res = await request(app)
      .delete(`/api/v1/location/elder/${elderId}/safe-zones/${zoneId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
  });

  it('노인이 삭제 시도 → 403', async () => {
    const { token } = setupAuth('elder');
    const res = await request(app)
      .delete(`/api/v1/location/elder/${elderId}/safe-zones/${zoneId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
