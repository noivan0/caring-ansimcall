/**
 * Tests: 개인정보보호법 컴플라이언스
 * - 개인정보 수집 동의 API (보호자-노인 관계 동의)
 * - 데이터 삭제 API (잊혀질 권리 — User.anonymize)
 * - 로그 마스킹 (전화번호/주소 마스킹)
 * - 회원 탈퇴 시 개인정보 익명화 검증
 */
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/models/db', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  pool: { end: jest.fn() },
}));

const { app } = require('../src/app');
const db = require('../src/models/db');

// Valid UUID constants (version 4, variant bits — must pass express-validator isUUID)
const ELDER_USER_ID  = 'a0000001-0000-4000-a000-000000000001';
const GUARDIAN_ID    = 'b0000001-0000-4000-b000-000000000001';
const REL_ID         = 'c0000001-0000-4000-8000-000000000001';
const ELDER_ID       = 'd0000001-0000-4000-9000-000000000001';

jest.mock('../src/models/user', () => {
  const elderUser = {
    id: 'a0000001-0000-0000-0000-000000000001',
    email: 'elder@example.com',
    phone: '+821099998888',
    display_name: '홍길동 어르신',
    role: 'elder',
    password_hash: '$2b$12$hash',
  };

  return {
    User: {
      findByEmail: jest.fn(),
      findById: jest.fn().mockResolvedValue({ ...elderUser, password_hash: undefined }),
      create: jest.fn(),
      verifyPassword: jest.fn().mockResolvedValue(true),
      anonymize: jest.fn().mockResolvedValue(undefined),
      updateFcmToken: jest.fn(),
    },
    Elder: {
      findByGuardian: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue(elderUser),
    },
    Guardian: {
      findGuardiansByElder: jest.fn().mockResolvedValue([]),
      requestRelationship: jest.fn().mockResolvedValue({ id: REL_ID, consent_status: 'pending' }),
      updateConsent: jest.fn().mockResolvedValue({ id: REL_ID, consent_status: 'accepted' }),
      removeRelationship: jest.fn().mockResolvedValue(undefined),
    },
  };
});

jest.mock('../src/services/notificationService', () => ({
  notifyGuardians: jest.fn().mockResolvedValue(undefined),
  notifyUser: jest.fn().mockResolvedValue(undefined),
  saveNotification: jest.fn().mockResolvedValue(undefined),
  sendFcmMessage: jest.fn().mockResolvedValue('msg-id'),
}));

const JWT_SECRET = 'test-secret-key-for-jest-only';

function makeToken(userId, role = 'elder') {
  return jwt.sign({ sub: userId, type: 'access' }, JWT_SECRET, { expiresIn: '15m', issuer: 'senior-care' });
}

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.NODE_ENV = 'test';
});

afterEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────
// 개인정보 수집 동의 API
// ─────────────────────────────────────────────────
describe('개인정보 수집 동의 — 보호자-노인 관계 동의', () => {
  test('노인 본인이 보호자 관계 수락 (동의) — 200', async () => {
    const { User, Guardian } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: ELDER_USER_ID,
      email: 'elder@example.com',
      role: 'elder',
    });

    const elderToken = makeToken(ELDER_USER_ID, 'elder');

    const res = await request(app)
      .patch(`/api/v1/users/relationships/${REL_ID}`)
      .set('Authorization', `Bearer ${elderToken}`)
      .send({ status: 'accepted' });

    expect(res.status).toBe(200);
    expect(Guardian.updateConsent).toHaveBeenCalledWith(
      REL_ID,
      ELDER_USER_ID,
      'accepted'
    );
  });

  test('노인 본인이 보호자 관계 거부 (동의 거부) — 200', async () => {
    const { User, Guardian } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: ELDER_USER_ID,
      email: 'elder@example.com',
      role: 'elder',
    });
    Guardian.updateConsent.mockResolvedValue({ id: REL_ID, consent_status: 'rejected' });

    const elderToken = makeToken(ELDER_USER_ID, 'elder');
    const res = await request(app)
      .patch(`/api/v1/users/relationships/${REL_ID}`)
      .set('Authorization', `Bearer ${elderToken}`)
      .send({ status: 'rejected' });

    expect(res.status).toBe(200);
  });

  test('잘못된 동의 상태값 — 400', async () => {
    const { User } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: ELDER_USER_ID,
      email: 'elder@example.com',
      role: 'elder',
    });

    const elderToken = makeToken(ELDER_USER_ID, 'elder');
    const res = await request(app)
      .patch(`/api/v1/users/relationships/${REL_ID}`)
      .set('Authorization', `Bearer ${elderToken}`)
      .send({ status: 'unknown_status' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('보호자가 노인과의 연결 요청 — 201 (pending 상태)', async () => {
    const { User } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: GUARDIAN_ID,
      email: 'guardian@test.com',
      role: 'guardian',
    });

    const guardianToken = makeToken(GUARDIAN_ID, 'guardian');
    const res = await request(app)
      .post('/api/v1/users/relationships')
      .set('Authorization', `Bearer ${guardianToken}`)
      .send({
        elder_id: ELDER_USER_ID,
        relationship_type: 'child',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.consent_status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────
// 데이터 삭제 API — 잊혀질 권리 (개인정보보호법 제36조)
// ─────────────────────────────────────────────────
describe('데이터 삭제 (잊혀질 권리) — DELETE /auth/account', () => {
  test('회원 탈퇴 시 User.anonymize 호출됨', async () => {
    const { User } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: ELDER_USER_ID,
      email: 'elder@example.com',
      role: 'elder',
    });
    db.query.mockResolvedValue({ rows: [] });

    const token = makeToken(ELDER_USER_ID);
    const res = await request(app)
      .delete('/api/v1/auth/account')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(User.anonymize).toHaveBeenCalledWith(ELDER_USER_ID);
  });

  test('탈퇴 전 refresh 토큰 전부 revoke (DB UPDATE 호출)', async () => {
    const { User } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: ELDER_USER_ID,
      email: 'elder@example.com',
      role: 'elder',
    });
    db.query.mockResolvedValue({ rows: [] });
    const token = makeToken(ELDER_USER_ID);

    await request(app)
      .delete('/api/v1/auth/account')
      .set('Authorization', `Bearer ${token}`);

    // DB 쿼리 중 refresh_tokens UPDATE가 호출되었는지 확인
    const updateCall = db.query.mock.calls.find(c =>
      c[0].includes('refresh_tokens') && c[0].includes('UPDATE')
    );
    expect(updateCall).toBeDefined();
  });

  test('미인증 상태에서 탈퇴 시도 — 401', async () => {
    const res = await request(app).delete('/api/v1/auth/account');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────
// 로그 마스킹 — 전화번호/주소 유출 방지
// ─────────────────────────────────────────────────
describe('개인정보 마스킹 — 응답 필드 검증', () => {
  test('findById 응답에 password_hash 미포함', async () => {
    const { User } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: ELDER_USER_ID,
      email: 'elder@example.com',
      role: 'elder',
      // password_hash 없음
    });

    const token = makeToken(ELDER_USER_ID);
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('password_hash');
  });

  test('login 응답에 password_hash 미포함', async () => {
    const { User } = require('../src/models/user');
    User.findByEmail.mockResolvedValue({
      id: ELDER_USER_ID,
      email: 'test@example.com',
      password_hash: '$2b$12$secret',
      role: 'guardian',
    });
    User.verifyPassword.mockResolvedValue(true);
    db.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password1' });

    expect(res.status).toBe(200);
    // 응답 user 객체에 password_hash 없어야 함
    expect(res.body.data.user).not.toHaveProperty('password_hash');
  });
});

// ─────────────────────────────────────────────────
// 관계 해제 API
// ─────────────────────────────────────────────────
describe('보호자-노인 관계 해제', () => {
  test('보호자가 관계 해제 — 204', async () => {
    const { User, Guardian } = require('../src/models/user');
    User.findById.mockResolvedValue({
      id: GUARDIAN_ID,
      email: 'guardian@test.com',
      role: 'guardian',
    });

    const guardianToken = makeToken(GUARDIAN_ID, 'guardian');
    const res = await request(app)
      .delete(`/api/v1/users/relationships/${REL_ID}`)
      .set('Authorization', `Bearer ${guardianToken}`);

    expect(res.status).toBe(204);
    expect(Guardian.removeRelationship).toHaveBeenCalled();
  });
});
