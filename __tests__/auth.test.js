/**
 * Tests: Authentication routes
 * - POST /api/v1/auth/register
 * - POST /api/v1/auth/login
 * - POST /api/v1/auth/refresh
 * - POST /api/v1/auth/logout
 * - DELETE /api/v1/auth/account
 */
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const db = require('../src/models/db');
const { User } = require('../src/models/user');

// Mock User model
jest.mock('../src/models/user', () => {
  const mockUser = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    email: 'test@example.com',
    phone: '+821012345678',
    display_name: '테스트 사용자',
    role: 'guardian',
    password_hash: '$2b$12$placeholder.hash',
  };

  return {
    User: {
      findByEmail: jest.fn(),
      findById: jest.fn().mockResolvedValue({ ...mockUser, password_hash: undefined }),
      create: jest.fn().mockResolvedValue({ id: mockUser.id, email: mockUser.email,
        phone: mockUser.phone, display_name: mockUser.display_name, role: mockUser.role }),
      verifyPassword: jest.fn(),
      anonymize: jest.fn().mockResolvedValue(undefined),
      updateFcmToken: jest.fn().mockResolvedValue(undefined),
    },
    Elder: { findByGuardian: jest.fn().mockResolvedValue([]) },
    Guardian: {
      requestRelationship: jest.fn().mockResolvedValue({ id: 'rel-id', consent_status: 'pending' }),
      updateConsent: jest.fn().mockResolvedValue({ id: 'rel-id', consent_status: 'accepted' }),
      removeRelationship: jest.fn().mockResolvedValue(undefined),
      findGuardiansByElder: jest.fn().mockResolvedValue([]),
    },
  };
});

const JWT_SECRET = 'test-secret-key-for-jest-only';
const JWT_REFRESH_SECRET = 'test-refresh-secret-for-jest-only';

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  jest.clearAllMocks();
});

function makeAccessToken(userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') {
  return jwt.sign({ sub: userId, type: 'access' }, JWT_SECRET, { expiresIn: '15m', issuer: 'senior-care' });
}

function makeRefreshToken(userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') {
  return jwt.sign({ sub: userId, type: 'refresh' }, JWT_REFRESH_SECRET, { expiresIn: '30d', issuer: 'senior-care' });
}

// ─────────────────────────────────────────────────
// POST /api/v1/auth/register
// ─────────────────────────────────────────────────
describe('POST /api/v1/auth/register', () => {
  const validBody = {
    email: 'newuser@example.com',
    phone: '+821012345678',
    password: 'Password1',
    display_name: '신규 사용자',
    role: 'guardian',
  };

  test('201 — 유효한 등록', async () => {
    User.findByEmail.mockResolvedValue(null);
    db.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/v1/auth/register').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data).toHaveProperty('refreshToken');
  });

  test('400 — 이메일 형식 오류', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validBody, email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('400 — 비밀번호 규칙 위반 (숫자 없음)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validBody, password: 'PasswordOnly' });
    expect(res.status).toBe(400);
  });

  test('400 — 전화번호 형식 오류', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validBody, phone: '01012345678' }); // +82 없음
    expect(res.status).toBe(400);
  });

  test('400 — 잘못된 role', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validBody, role: 'admin' });
    expect(res.status).toBe(400);
  });

  test('409 — 이미 존재하는 이메일', async () => {
    User.findByEmail.mockResolvedValue({ id: 'existing-id' });
    const res = await request(app).post('/api/v1/auth/register').send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('EMAIL_TAKEN');
  });
});

// ─────────────────────────────────────────────────
// POST /api/v1/auth/login
// ─────────────────────────────────────────────────
describe('POST /api/v1/auth/login', () => {
  const mockUser = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    email: 'test@example.com',
    phone: '+821012345678',
    display_name: '테스트 사용자',
    role: 'guardian',
    password_hash: '$2b$12$hashedpassword',
  };

  test('200 — 로그인 성공', async () => {
    User.findByEmail.mockResolvedValue(mockUser);
    User.verifyPassword.mockResolvedValue(true);
    db.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(res.body.data.user).not.toHaveProperty('password_hash');
  });

  test('401 — 잘못된 비밀번호', async () => {
    User.findByEmail.mockResolvedValue(mockUser);
    User.verifyPassword.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Wrong1234' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  test('401 — 사용자 없음', async () => {
    User.findByEmail.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'Password1' });
    expect(res.status).toBe(401);
  });

  test('400 — 이메일 누락', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: 'Password1' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────
// POST /api/v1/auth/refresh
// ─────────────────────────────────────────────────
describe('POST /api/v1/auth/refresh', () => {
  test('200 — 유효한 refresh token', async () => {
    const refreshToken = makeRefreshToken();
    db.query.mockResolvedValue({ rows: [{ id: 'token-row-id' }] });

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('accessToken');
  });

  test('401 — 잘못된 refresh token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'invalid.token.here' });
    expect(res.status).toBe(401);
  });

  test('401 — access token으로 refresh 시도', async () => {
    // refresh secret으로 서명되었지만 type이 access인 토큰 (type 검사를 통과시키기 위해)
    const wrongTypeToken = jwt.sign(
      { sub: 'user-id', type: 'access' },  // type: access (refresh 아님)
      process.env.JWT_REFRESH_SECRET,       // refresh secret으로 서명 → 서명 검증은 통과
      { expiresIn: '30d', issuer: 'senior-care' }
    );
    db.query.mockResolvedValue({ rows: [{ id: 'token-id' }] });
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: wrongTypeToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN_TYPE');
  });

  test('401 — DB에서 revoked된 토큰', async () => {
    const refreshToken = makeRefreshToken();
    db.query.mockResolvedValue({ rows: [] }); // revoked

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_REVOKED');
  });
});

// ─────────────────────────────────────────────────
// POST /api/v1/auth/logout
// ─────────────────────────────────────────────────
describe('POST /api/v1/auth/logout', () => {
  test('204 — 로그아웃 성공', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const token = makeAccessToken();

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({ refreshToken: makeRefreshToken() });
    expect(res.status).toBe(204);
  });

  test('401 — 토큰 없음', async () => {
    const res = await request(app).post('/api/v1/auth/logout').send({});
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────
// DELETE /api/v1/auth/account
// ─────────────────────────────────────────────────
describe('DELETE /api/v1/auth/account', () => {
  test('204 — 회원 탈퇴 (익명화)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const token = makeAccessToken();

    const res = await request(app)
      .delete('/api/v1/auth/account')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(User.anonymize).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────
// 헬스체크
// ─────────────────────────────────────────────────
describe('GET /ping', () => {
  test('200 — 서버 상태 확인', async () => {
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('404 handler', () => {
  test('404 — 존재하지 않는 엔드포인트', async () => {
    const res = await request(app).get('/api/v1/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
