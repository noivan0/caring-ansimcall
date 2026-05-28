/**
 * tests/auth.test.js — JWT 발급/검증 + 인증 라우터 테스트
 *
 * 커버:
 *   POST /api/v1/auth/register — 신규 가입 (중복 이메일, 유효성 검사)
 *   POST /api/v1/auth/login    — 로그인 + JWT 발급
 *   POST /api/v1/auth/refresh  — Access 토큰 갱신
 *   POST /api/v1/auth/logout   — 로그아웃 (refresh 토큰 무효화)
 *   authenticate 미들웨어:
 *     - 만료 토큰 → 401 TOKEN_EXPIRED
 *     - 없는 사용자 → 401 USER_NOT_FOUND
 *     - Refresh 토큰으로 API 직접 접근 → 401 INVALID_TOKEN_TYPE
 */

'use strict';

jest.mock('../src/models/user', () => ({
  User: {
    findById:       jest.fn(),
    findByEmail:    jest.fn(),
    create:         jest.fn(),
    verifyPassword: jest.fn(),
    anonymize:      jest.fn(),
  },
  Elder:    {},
  Guardian: {},
}));

jest.mock('../src/services/notificationService', () => ({
  notifyGuardians: jest.fn().mockResolvedValue(undefined),
  notifyUser:      jest.fn().mockResolvedValue(undefined),
  sendFcmMessage:  jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('./testApp');
const { makeToken, makeRefreshToken, UUIDS, fakeUser, SECRET, REFRESH_SECRET } = require('./fixtures');
const { User } = require('../src/models/user');
const db       = require('../src/models/db');

// ────────────────────────────────────────────────────────────────
// POST /api/v1/auth/register
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register', () => {
  const validPayload = {
    email:        'newuser@example.com',
    phone:        '+821012345678',
    password:     'Secure1234',
    display_name: '신규사용자',
    role:         'guardian',
  };

  beforeEach(() => {
    User.findByEmail.mockResolvedValue(null);
    User.create.mockResolvedValue({
      id:           UUIDS.guardian1,
      email:        'newuser@example.com',
      display_name: '신규사용자',
      role:         'guardian',
    });
    db.query.mockResolvedValue({ rows: [], rowCount: 1 }); // refresh_token INSERT
  });

  it('정상 가입 → 201 + accessToken + refreshToken', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user.email).toBe('newuser@example.com');
  });

  it('이메일 중복 → 409 EMAIL_TAKEN', async () => {
    User.findByEmail.mockResolvedValue({ id: 'existing', email: 'newuser@example.com' });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send(validPayload);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('EMAIL_TAKEN');
  });

  it('이메일 형식 오류 → 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validPayload, email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('비밀번호 정책 위반 (숫자 없음) → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validPayload, password: 'NoNumbersHere' });

    expect(res.status).toBe(400);
  });

  it('비밀번호 8자 미만 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validPayload, password: 'A1b2c' });

    expect(res.status).toBe(400);
  });

  it('잘못된 role → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validPayload, role: 'admin' });

    expect(res.status).toBe(400);
  });

  it('한국 전화번호 형식 오류 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validPayload, phone: '01012345678' }); // +82 없음

    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/v1/auth/login
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/login', () => {
  const loginPayload = { email: 'user@example.com', password: 'Secure1234' };
  const dbUser = { ...fakeUser(), email: 'user@example.com', password_hash: '$2b$12$hash' };

  beforeEach(() => {
    User.findByEmail.mockResolvedValue(dbUser);
    User.verifyPassword.mockResolvedValue(true);
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('정상 로그인 → 200 + JWT pair', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send(loginPayload);

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    // 응답에 password_hash 포함 금지
    expect(res.body.data.user.password_hash).toBeUndefined();
  });

  it('비밀번호 불일치 → 401 INVALID_CREDENTIALS', async () => {
    User.verifyPassword.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send(loginPayload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('존재하지 않는 이메일 → 401 INVALID_CREDENTIALS', async () => {
    User.findByEmail.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send(loginPayload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('이메일 형식 오류 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'bad', password: 'Secure1234' });

    expect(res.status).toBe(400);
  });

  it('발급된 accessToken이 올바른 JWT 구조 (sub=userId, type=access)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send(loginPayload);

    const payload = jwt.verify(res.body.data.accessToken, SECRET);
    expect(payload.type).toBe('access');
    expect(payload.sub).toBe(dbUser.id);
    expect(payload.iss).toBe('senior-care');
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/v1/auth/refresh — 토큰 갱신
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/refresh', () => {
  it('유효한 refreshToken → 200 + 새 accessToken', async () => {
    const userId       = UUIDS.guardian1;
    const refreshToken = makeRefreshToken(userId);

    // DB 화이트리스트 확인
    db.query.mockResolvedValueOnce({ rows: [{ id: 'tok-1' }], rowCount: 1 });

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    const payload = jwt.verify(res.body.data.accessToken, SECRET);
    expect(payload.type).toBe('access');
  });

  it('만료된 refreshToken → 401 INVALID_TOKEN', async () => {
    const expired = jwt.sign(
      { sub: UUIDS.guardian1, type: 'refresh' },
      REFRESH_SECRET,
      { expiresIn: '-1s', issuer: 'senior-care' }
    );

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: expired });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('DB 화이트리스트에 없는 토큰 → 401 TOKEN_REVOKED', async () => {
    const userId       = UUIDS.guardian1;
    const refreshToken = makeRefreshToken(userId);

    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // not whitelisted

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_REVOKED');
  });

  it('Access 토큰을 refreshToken으로 사용 → 401 INVALID_TOKEN_TYPE', async () => {
    const accessToken = makeToken('guardian', UUIDS.guardian1);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: accessToken });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN_TYPE');
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/v1/auth/logout
// ────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/logout', () => {
  it('로그아웃 → 204', async () => {
    const user  = fakeUser();
    User.findById.mockResolvedValue(user);
    const token = makeToken('guardian', user.id);
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const refreshToken = makeRefreshToken(user.id);

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({ refreshToken });

    expect(res.status).toBe(204);
    // refresh_token 무효화 DB 쿼리 확인
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE refresh_tokens'),
      expect.any(Array)
    );
  });

  it('인증 없이 → 401', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────
// authenticate 미들웨어 엣지 케이스
// ────────────────────────────────────────────────────────────────

describe('authenticate 미들웨어 엣지 케이스', () => {
  it('Authorization 헤더 없음 → 401 MISSING_TOKEN', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('MISSING_TOKEN');
  });

  it('Bearer 스킴 오류 (Token X X X) → 401 MISSING_TOKEN', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', 'Token faketoken');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('MISSING_TOKEN');
  });

  it('만료 토큰 → 401 TOKEN_EXPIRED', async () => {
    const expired = jwt.sign(
      { sub: UUIDS.guardian1, type: 'access' },
      SECRET,
      { expiresIn: '-1s', issuer: 'senior-care' }
    );

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOKEN_EXPIRED');
  });

  it('Refresh 토큰으로 API 직접 호출 → 401 INVALID_TOKEN_TYPE', async () => {
    const refresh = makeRefreshToken(UUIDS.guardian1);

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${refresh}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN_TYPE');
  });

  it('유효 토큰이지만 DB에 없는 사용자 → 401 USER_NOT_FOUND', async () => {
    User.findById.mockResolvedValue(null);
    const token = makeToken('guardian', UUIDS.guardian1);

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('USER_NOT_FOUND');
  });

  it('서명 키 위조 토큰 → 401 INVALID_TOKEN', async () => {
    const fakeToken = jwt.sign(
      { sub: UUIDS.guardian1, type: 'access' },
      'wrong-secret',
      { expiresIn: '1h', issuer: 'senior-care' }
    );

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${fakeToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });
});
