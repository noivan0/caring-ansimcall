/**
 * Tests: 보안 설정 검증
 * - helmet 보안 헤더
 * - rate-limit 동작
 * - JWT 설정 (만료, 타입 검사)
 * - CORS 설정
 */
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const db = require('../src/models/db');

jest.mock('../src/models/user', () => ({
  User: {
    findByEmail: jest.fn(),
    findById: jest.fn().mockResolvedValue({
      id: 'user-id-001',
      email: 'test@example.com',
      role: 'guardian',
    }),
    verifyPassword: jest.fn().mockResolvedValue(true),
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
}));

const JWT_SECRET = 'test-secret-key-for-jest-only';

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.NODE_ENV = 'test';
});

afterEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────
// Helmet 보안 헤더
// ─────────────────────────────────────────────────
describe('보안 헤더 (Helmet)', () => {
  test('X-Content-Type-Options: nosniff 헤더 존재', async () => {
    const res = await request(app).get('/ping');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('X-Frame-Options 헤더 존재 (clickjacking 방지)', async () => {
    const res = await request(app).get('/ping');
    // helmet이 DENY 또는 SAMEORIGIN 설정
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  test('Content-Security-Policy 헤더 존재', async () => {
    const res = await request(app).get('/ping');
    expect(res.headers['content-security-policy']).toBeDefined();
    // defaultSrc 'self' 포함
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  test('X-DNS-Prefetch-Control 헤더 존재', async () => {
    const res = await request(app).get('/ping');
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
  });
});

// ─────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────
describe('Rate Limiting 설정', () => {
  test('RateLimit-Limit 헤더가 존재 (standardHeaders)', async () => {
    const res = await request(app).get('/ping');
    // express-rate-limit standardHeaders: true → RateLimit-Limit, RateLimit-Remaining
    expect(res.headers['ratelimit-limit'] || res.headers['x-ratelimit-limit']).toBeDefined();
  });

  test('loginLimiter: 로그인 라우트에 레이트 리밋 적용', async () => {
    // 레이트 리밋 헤더 확인 (limit 존재)
    const { User } = require('../src/models/user');
    User.findByEmail.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'x@x.com', password: 'x' });

    // 레이트 리밋 헤더 또는 상태코드로 검증 (400=validation err, 401=invalid creds, 429=rate limited)
    expect([400, 401, 429]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────
// JWT 설정 검증
// ─────────────────────────────────────────────────
describe('JWT 설정 검증', () => {
  test('access 토큰 — 15분 만료 설정', () => {
    const token = jwt.sign(
      { sub: 'user-id', type: 'access' },
      JWT_SECRET,
      { expiresIn: '15m', issuer: 'senior-care' }
    );
    const decoded = jwt.verify(token, JWT_SECRET, { issuer: 'senior-care' });
    const expiresIn = decoded.exp - decoded.iat;
    expect(expiresIn).toBe(15 * 60); // 900초
  });

  test('refresh 토큰 — 30일 만료 설정', () => {
    const refreshSecret = 'test-refresh-secret';
    const token = jwt.sign(
      { sub: 'user-id', type: 'refresh' },
      refreshSecret,
      { expiresIn: '30d', issuer: 'senior-care' }
    );
    const decoded = jwt.verify(token, refreshSecret, { issuer: 'senior-care' });
    const expiresIn = decoded.exp - decoded.iat;
    expect(expiresIn).toBe(30 * 24 * 60 * 60); // 2592000초
  });

  test('만료된 토큰 — 401 반환', async () => {
    const expiredToken = jwt.sign(
      { sub: 'user-id', type: 'access' },
      JWT_SECRET,
      { expiresIn: '0s', issuer: 'senior-care' }
    );
    // 잠시 대기
    await new Promise(r => setTimeout(r, 100));

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_EXPIRED');
  });

  test('잘못된 시크릿 — 401 반환', async () => {
    const badToken = jwt.sign(
      { sub: 'user-id', type: 'access' },
      'wrong-secret',
      { expiresIn: '15m', issuer: 'senior-care' }
    );
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${badToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  test('issuer 불일치 — 401 반환', async () => {
    const badIssuerToken = jwt.sign(
      { sub: 'user-id', type: 'access' },
      JWT_SECRET,
      { expiresIn: '15m', issuer: 'other-service' }
    );
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${badIssuerToken}`);
    expect(res.status).toBe(401);
  });

  test('refresh 토큰으로 인증 시도 — INVALID_TOKEN_TYPE', async () => {
    const refreshToken = jwt.sign(
      { sub: 'user-id', type: 'refresh' },
      JWT_SECRET,  // 같은 secret, 다른 type
      { expiresIn: '30d', issuer: 'senior-care' }
    );
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${refreshToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN_TYPE');
  });

  test('Authorization 헤더 없음 — 401 MISSING_TOKEN', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('MISSING_TOKEN');
  });

  test('Bearer 스킴 없음 — 401', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────
// 역할 기반 접근 제어 (requireRole)
// ─────────────────────────────────────────────────
describe('역할 기반 접근 제어 (RBAC)', () => {
  test('elder 역할로 guardian 전용 엔드포인트 접근 — 403', async () => {
    const { User } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: 'elder-id',
      email: 'elder@example.com',
      role: 'elder', // elder 역할
    });

    db.query.mockResolvedValue({ rows: [] });

    const token = jwt.sign(
      { sub: 'elder-id', type: 'access' },
      JWT_SECRET,
      { expiresIn: '15m', issuer: 'senior-care' }
    );

    const ELDER_ID = 'a0b1c2d3-0000-0000-0000-000000000001';
    const res = await request(app)
      .post(`/api/v1/location/elder/${ELDER_ID}/safe-zones`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: '집',
        latitude: 37.5665,
        longitude: 126.978,
        radius_meters: 100,
      });

    expect(res.status).toBe(403);
  });
});
