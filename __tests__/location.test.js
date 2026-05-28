/**
 * Tests: 위치 공유 라우터
 * - POST /api/v1/location/elder/:elderId
 * - GET  /api/v1/location/elder/:elderId/current
 * - GET  /api/v1/location/elder/:elderId/history
 * - POST /api/v1/location/elder/:elderId/safe-zones
 * - GET  /api/v1/location/elder/:elderId/safe-zones
 * - DELETE /api/v1/location/elder/:elderId/safe-zones/:zoneId
 */
'use strict';

jest.mock('../src/models/db', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  pool: { end: jest.fn() },
}));

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const db = require('../src/models/db');

jest.mock('../src/models/user', () => {
  const guardianUser = {
    id: 'a0b1c2d3-e4f5-6789-abcd-ef0123456003',
    email: 'guardian@example.com',
    display_name: '보호자',
    role: 'guardian',
  };

  return {
    User: {
      findByEmail: jest.fn(),
      findById: jest.fn().mockResolvedValue(guardianUser),
      verifyPassword: jest.fn(),
      create: jest.fn(),
      anonymize: jest.fn(),
      updateFcmToken: jest.fn(),
    },
    Elder: { findByGuardian: jest.fn().mockResolvedValue([]) },
    Guardian: {
      findGuardiansByElder: jest.fn().mockResolvedValue([]),
      requestRelationship: jest.fn(),
      updateConsent: jest.fn(),
      removeRelationship: jest.fn(),
    },
  };
});

// notification service mock
jest.mock('../src/services/notificationService', () => ({
  notifyGuardians: jest.fn().mockResolvedValue(undefined),
  notifyUser: jest.fn().mockResolvedValue(undefined),
  saveNotification: jest.fn().mockResolvedValue(undefined),
  sendFcmMessage: jest.fn().mockResolvedValue('msg-id'),
}));

const JWT_SECRET='test-s...only';
const ELDER_ID   = 'a0b1c2d3-e4f5-6789-abcd-ef0123456001';
const ZONE_ID    = 'a0b1c2d3-e4f5-6789-abcd-ef0123456002';
const GUARDIAN_ID = 'a0b1c2d3-e4f5-6789-abcd-ef0123456003';

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.NODE_ENV = 'test';
});

afterEach(() => jest.clearAllMocks());

function guardianToken(guardianId = 'a0b1c2d3-e4f5-6789-abcd-ef0123456003') {
  return jwt.sign({ sub: guardianId, type: 'access' }, JWT_SECRET, { expiresIn: '15m', issuer: 'senior-care' });
}

// ── 관계 확인 mock 헬퍼 ─────────────────────────────────────
function mockGuardianAccess() {
  // checkRelationship: guardian 접근 허용
  db.query.mockImplementation((sql) => {
    if (sql.includes('guardian_relationships')) {
      return Promise.resolve({ rows: [{ id: 'rel-id' }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

// ─────────────────────────────────────────────────
// POST /location/elder/:elderId — 위치 업데이트
// ─────────────────────────────────────────────────
describe('POST /api/v1/location/elder/:elderId', () => {
  const validBody = {
    latitude: 37.5665,
    longitude: 126.978,
    accuracy: 10.5,
  };

  test('201 — 위치 업데이트 성공', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('guardian_relationships')) {
        return Promise.resolve({ rows: [{ id: 'rel-id' }] });
      }
      if (sql.includes('safe_zones')) {
        return Promise.resolve({ rows: [{ id: ZONE_ID, name: '집', is_inside: true }] });
      }
      if (sql.includes('location_logs')) {
        return Promise.resolve({ rows: [{ id: 'loc-id', elder_id: ELDER_ID, ...validBody, is_in_safe_zone: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('elder_id');
  });

  test('400 — 위도 범위 초과 (한국 밖)', async () => {
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ latitude: 10.0, longitude: 126.978 }); // 위도 범위 벗어남
    expect(res.status).toBe(400);
  });

  test('400 — 경도 범위 초과', async () => {
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ latitude: 37.5, longitude: 200.0 }); // 경도 범위 벗어남
    expect(res.status).toBe(400);
  });

  test('400 — 잘못된 elderId (UUID 아님)', async () => {
    const res = await request(app)
      .post('/api/v1/location/elder/not-a-uuid')
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send(validBody);
    expect(res.status).toBe(400);
  });

  test('401 — 미인증 요청', async () => {
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .send(validBody);
    expect(res.status).toBe(401);
  });

  test('403 — 관계 없는 보호자', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('guardian_relationships')) {
        return Promise.resolve({ rows: [] }); // 관계 없음
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send(validBody);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────
// GET /location/elder/:elderId/current
// ─────────────────────────────────────────────────
describe('GET /api/v1/location/elder/:elderId/current', () => {
  test('200 — 현재 위치 조회 성공', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('guardian_relationships')) {
        return Promise.resolve({ rows: [{ id: 'rel-id' }] });
      }
      return Promise.resolve({
        rows: [{
          latitude: 37.5665,
          longitude: 126.978,
          is_in_safe_zone: true,
          recorded_at: new Date().toISOString(),
          elder_name: '홍길동',
        }],
      });
    });

    const res = await request(app)
      .get(`/api/v1/location/elder/${ELDER_ID}/current`)
      .set('Authorization', `Bearer ${guardianToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('latitude');
  });

  test('404 — 위치 데이터 없음', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('guardian_relationships')) {
        return Promise.resolve({ rows: [{ id: 'rel-id' }] });
      }
      return Promise.resolve({ rows: [] }); // 데이터 없음
    });

    const res = await request(app)
      .get(`/api/v1/location/elder/${ELDER_ID}/current`)
      .set('Authorization', `Bearer ${guardianToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NO_LOCATION_DATA');
  });
});

// ─────────────────────────────────────────────────
// 안전구역 알고리즘 정확도 — 위도/경도 범위 검증
// ─────────────────────────────────────────────────
describe('위치 안전구역 알고리즘 정확도 검증', () => {
  test('한국 위도 최남단 (33.0) — 경계값 허용', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('guardian_relationships')) return Promise.resolve({ rows: [{ id: 'rel' }] });
      if (sql.includes('safe_zones')) return Promise.resolve({ rows: [] });
      if (sql.includes('location_logs')) return Promise.resolve({ rows: [{ id: 'l', elder_id: ELDER_ID, latitude: 33.0, longitude: 126.0, is_in_safe_zone: false }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ latitude: 33.0, longitude: 126.0 });
    expect(res.status).toBe(201);
  });

  test('한국 위도 최북단 (43.0) — 경계값 허용', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('guardian_relationships')) return Promise.resolve({ rows: [{ id: 'rel' }] });
      if (sql.includes('safe_zones')) return Promise.resolve({ rows: [] });
      if (sql.includes('location_logs')) return Promise.resolve({ rows: [{ id: 'l', elder_id: ELDER_ID, latitude: 43.0, longitude: 128.0, is_in_safe_zone: false }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ latitude: 43.0, longitude: 128.0 });
    expect(res.status).toBe(201);
  });

  test('한국 경계 밖 위도 (32.9) — 검증 실패', async () => {
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ latitude: 32.9, longitude: 126.0 });
    expect(res.status).toBe(400);
  });

  test('일본 위치 (35.0, 139.0) — 경도 범위 초과', async () => {
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ latitude: 35.0, longitude: 139.0 });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────
// POST /location/elder/:elderId/safe-zones — 안전구역 등록
// ─────────────────────────────────────────────────
describe('POST /api/v1/location/elder/:elderId/safe-zones', () => {
  const zoneBody = {
    name: '집',
    latitude: 37.5665,
    longitude: 126.978,
    radius_meters: 100,
    icon: 'home',
  };

  test('201 — 안전구역 등록 성공', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('guardian_relationships')) return Promise.resolve({ rows: [{ id: 'rel-id' }] });
      if (sql.includes('safe_zones')) return Promise.resolve({
        rows: [{ id: ZONE_ID, name: '집', radius_meters: 100, icon: 'home', is_active: true, created_at: new Date().toISOString() }],
      });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}/safe-zones`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send(zoneBody);
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('집');
  });

  test('400 — radius_meters 범위 초과 (5001)', async () => {
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}/safe-zones`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ ...zoneBody, radius_meters: 5001 });
    expect(res.status).toBe(400);
  });

  test('400 — radius_meters 최소 미달 (49)', async () => {
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}/safe-zones`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ ...zoneBody, radius_meters: 49 });
    expect(res.status).toBe(400);
  });

  test('400 — 잘못된 icon 값', async () => {
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}/safe-zones`)
      .set('Authorization', `Bearer ${guardianToken()}`)
      .send({ ...zoneBody, icon: 'invalid_icon' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────
// GET /location/elder/:elderId/history
// ─────────────────────────────────────────────────
describe('GET /api/v1/location/elder/:elderId/history', () => {
  test('200 — 이동 이력 조회', async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes('guardian_relationships')) return Promise.resolve({ rows: [{ id: 'rel-id' }] });
      return Promise.resolve({
        rows: [
          { latitude: 37.5, longitude: 126.9, is_in_safe_zone: true, recorded_at: new Date().toISOString() },
        ],
        rowCount: 1,
      });
    });

    const res = await request(app)
      .get(`/api/v1/location/elder/${ELDER_ID}/history`)
      .set('Authorization', `Bearer ${guardianToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  test('400 — limit 최대 초과 (501)', async () => {
    const res = await request(app)
      .get(`/api/v1/location/elder/${ELDER_ID}/history?limit=501`)
      .set('Authorization', `Bearer ${guardianToken()}`);
    expect(res.status).toBe(400);
  });
});
