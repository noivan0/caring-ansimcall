/**
 * __tests__/health_profile.test.js — HealthProfile 모델 + API 테스트
 */
'use strict';

// SQLite (better-sqlite3)를 메모리 DB로 교체
jest.mock('../src/models/HealthProfile', () => {
  const Database = require('better-sqlite3');
  const memDb = new Database(':memory:');
  memDb.pragma('journal_mode = WAL');
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS health_profiles (
      user_id           TEXT PRIMARY KEY,
      name              TEXT,
      age               INTEGER,
      conditions        TEXT DEFAULT '[]',
      medications       TEXT DEFAULT '[]',
      allergies         TEXT DEFAULT '[]',
      doctor_name       TEXT,
      doctor_phone      TEXT,
      blood_type        TEXT,
      emergency_contact TEXT DEFAULT '{}',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
  `);

  function rowToProfile(row) {
    if (!row) return null;
    return {
      userId:           row.user_id,
      name:             row.name,
      age:              row.age,
      conditions:       JSON.parse(row.conditions  || '[]'),
      medications:      JSON.parse(row.medications || '[]'),
      allergies:        JSON.parse(row.allergies   || '[]'),
      doctorName:       row.doctor_name,
      doctorPhone:      row.doctor_phone,
      bloodType:        row.blood_type,
      emergencyContact: JSON.parse(row.emergency_contact || '{}'),
      createdAt:        row.created_at,
      updatedAt:        row.updated_at,
    };
  }

  function serArr(v) {
    if (Array.isArray(v)) return JSON.stringify(v);
    return '[]';
  }

  function serObj(v) {
    if (!v) return '{}';
    if (typeof v === 'object') return JSON.stringify(v);
    return '{}';
  }

  const HealthProfile = {
    findByUserId(userId) {
      const row = memDb.prepare('SELECT * FROM health_profiles WHERE user_id = ?').get(userId);
      return rowToProfile(row);
    },
    create(userId, data) {
      const now = new Date().toISOString();
      const { name, age, conditions, medications, allergies, doctorName, doctorPhone, bloodType, emergencyContact } = data;
      memDb.prepare(`
        INSERT INTO health_profiles (user_id,name,age,conditions,medications,allergies,doctor_name,doctor_phone,blood_type,emergency_contact,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(userId, name||null, age||null, serArr(conditions), serArr(medications), serArr(allergies), doctorName||null, doctorPhone||null, bloodType||null, serObj(emergencyContact), now, now);
      return this.findByUserId(userId);
    },
    update(userId, data) {
      const existing = this.findByUserId(userId);
      if (!existing) return this.create(userId, data);
      const now = new Date().toISOString();
      const { name, age, conditions, medications, allergies, doctorName, doctorPhone, bloodType, emergencyContact } = data;
      memDb.prepare(`
        UPDATE health_profiles SET
          name=COALESCE(?,name), age=COALESCE(?,age),
          conditions=COALESCE(?,conditions), medications=COALESCE(?,medications),
          allergies=COALESCE(?,allergies), doctor_name=COALESCE(?,doctor_name),
          doctor_phone=COALESCE(?,doctor_phone), blood_type=COALESCE(?,blood_type),
          emergency_contact=COALESCE(?,emergency_contact), updated_at=?
        WHERE user_id=?
      `).run(
        name!==undefined?name:null, age!==undefined?age:null,
        conditions!==undefined?serArr(conditions):null, medications!==undefined?serArr(medications):null,
        allergies!==undefined?serArr(allergies):null, doctorName!==undefined?doctorName:null,
        doctorPhone!==undefined?doctorPhone:null, bloodType!==undefined?bloodType:null,
        emergencyContact!==undefined?serObj(emergencyContact):null, now, userId
      );
      return this.findByUserId(userId);
    },
    delete(userId) {
      const r = memDb.prepare('DELETE FROM health_profiles WHERE user_id = ?').run(userId);
      return r.changes > 0;
    },
  };

  return { HealthProfile };
});

jest.mock('../src/models/user', () => ({
  User: { findById: jest.fn(), findByEmail: jest.fn(), create: jest.fn(), verifyPassword: jest.fn(), anonymize: jest.fn() },
  Elder: {}, Guardian: {},
}));

const request = require('supertest');
const express = require('express');
const helmet  = require('helmet');
const { authenticate } = require('../src/middleware/auth');
const { i18nMiddleware } = require('../src/middleware/i18n');
const healthProfileRouter = require('../src/routes/healthProfile');
const { HealthProfile } = require('../src/models/HealthProfile');
const { User } = require('../src/models/user');
const jwt = require('jsonwebtoken');

const SECRET = 'test-secret-key-1234567890';
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV   = 'test';

function makeToken(role = 'guardian', userId = 'user-uuid-1') {
  return jwt.sign({ sub: userId, type: 'access', role }, SECRET, { expiresIn: '1h', issuer: 'senior-care' });
}

function makeApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json());
  app.use(i18nMiddleware());
  app.use('/api/health-profile', healthProfileRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.code || 'INTERNAL_ERROR', message: err.message });
  });
  return app;
}

const app = makeApp();
const GUARDIAN_ID = 'guardian-001';
const ELDER_ID    = 'elder-001';

function setupAuth(role = 'guardian', userId = GUARDIAN_ID) {
  User.findById.mockResolvedValue({ id: userId, role, email: `${role}@test.com`, display_name: '테스트' });
  return makeToken(role, userId);
}

afterEach(() => {
  jest.clearAllMocks();
  // 프로필 초기화
  HealthProfile.delete(GUARDIAN_ID);
  HealthProfile.delete(ELDER_ID);
  HealthProfile.delete('user-new-001');
});

// ────────────────────────────────────────────────────────────────
// HealthProfile 모델 단위 테스트
// ────────────────────────────────────────────────────────────────
describe('HealthProfile 모델', () => {
  test('프로필 생성 → findByUserId로 조회 가능', () => {
    const profile = HealthProfile.create('user-model-1', {
      name: '홍길동',
      age:  80,
      conditions: ['고혈압', '당뇨'],
      medications: ['혈압약'],
      allergies: ['페니실린'],
      doctorName: '김의사',
      doctorPhone: '02-1234-5678',
      bloodType: 'A+',
      emergencyContact: { name: '홍보호자', phone: '010-9999-8888', relation: '자녀' },
    });

    expect(profile.userId).toBe('user-model-1');
    expect(profile.name).toBe('홍길동');
    expect(profile.age).toBe(80);
    expect(profile.conditions).toEqual(['고혈압', '당뇨']);
    expect(profile.medications).toEqual(['혈압약']);
    expect(profile.allergies).toEqual(['페니실린']);
    expect(profile.doctorName).toBe('김의사');
    expect(profile.bloodType).toBe('A+');
    expect(profile.emergencyContact.name).toBe('홍보호자');
    HealthProfile.delete('user-model-1');
  });

  test('존재하지 않는 userId → null', () => {
    expect(HealthProfile.findByUserId('nonexistent-user')).toBeNull();
  });

  test('update → 필드 갱신', () => {
    HealthProfile.create('user-model-2', { name: '이순신', age: 75 });
    const updated = HealthProfile.update('user-model-2', { age: 76, conditions: ['관절염'] });
    expect(updated.age).toBe(76);
    expect(updated.conditions).toEqual(['관절염']);
    expect(updated.name).toBe('이순신'); // 변경 안 된 필드 유지
    HealthProfile.delete('user-model-2');
  });

  test('delete → 이후 조회 시 null', () => {
    HealthProfile.create('user-model-3', { name: '세종대왕' });
    HealthProfile.delete('user-model-3');
    expect(HealthProfile.findByUserId('user-model-3')).toBeNull();
  });

  test('update 존재하지 않으면 생성 (upsert)', () => {
    const profile = HealthProfile.update('user-model-4', { name: '신규사용자' });
    expect(profile.name).toBe('신규사용자');
    HealthProfile.delete('user-model-4');
  });
});

// ────────────────────────────────────────────────────────────────
// GET /api/health-profile/:userId
// ────────────────────────────────────────────────────────────────
describe('GET /api/health-profile/:userId', () => {
  test('인증 없이 → 401', async () => {
    const res = await request(app).get(`/api/health-profile/${GUARDIAN_ID}`);
    expect(res.status).toBe(401);
  });

  test('프로필 없음 → 404', async () => {
    const token = setupAuth('guardian', GUARDIAN_ID);
    const res = await request(app)
      .get(`/api/health-profile/${GUARDIAN_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PROFILE_NOT_FOUND');
  });

  test('프로필 존재 → 200 + data', async () => {
    HealthProfile.create(GUARDIAN_ID, { name: '홍길동', age: 80, bloodType: 'O+' });
    const token = setupAuth('guardian', GUARDIAN_ID);
    const res = await request(app)
      .get(`/api/health-profile/${GUARDIAN_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('홍길동');
    expect(res.body.data.bloodType).toBe('O+');
  });

  test('elder가 타인 프로필 조회 → 403', async () => {
    HealthProfile.create(GUARDIAN_ID, { name: '홍길동' });
    const token = setupAuth('elder', ELDER_ID);
    const res = await request(app)
      .get(`/api/health-profile/${GUARDIAN_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('guardian이 타인 프로필 조회 → 200 (허용)', async () => {
    HealthProfile.create(ELDER_ID, { name: '노인프로필' });
    const token = setupAuth('guardian', GUARDIAN_ID);
    const res = await request(app)
      .get(`/api/health-profile/${ELDER_ID}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────
// POST /api/health-profile/:userId
// ────────────────────────────────────────────────────────────────
describe('POST /api/health-profile/:userId', () => {
  const validPayload = {
    name: '홍길동',
    age:  80,
    conditions:  ['고혈압'],
    medications: ['혈압약'],
    allergies:   ['페니실린'],
    doctorName:  '김의사',
    doctorPhone: '02-1234-5678',
    bloodType:   'A+',
    emergencyContact: { name: '홍보호자', phone: '010-9999-8888', relation: '자녀' },
  };

  test('정상 생성 → 201 + data', async () => {
    const token = setupAuth('guardian', GUARDIAN_ID);
    const res = await request(app)
      .post(`/api/health-profile/${GUARDIAN_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('홍길동');
    expect(res.body.data.conditions).toEqual(['고혈압']);
  });

  test('중복 생성 → 409', async () => {
    const token = setupAuth('guardian', GUARDIAN_ID);
    HealthProfile.create(GUARDIAN_ID, validPayload);
    const res = await request(app)
      .post(`/api/health-profile/${GUARDIAN_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PROFILE_EXISTS');
  });

  test('잘못된 bloodType → 400', async () => {
    const token = setupAuth('guardian', GUARDIAN_ID);
    const res = await request(app)
      .post(`/api/health-profile/${GUARDIAN_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, bloodType: 'Z+' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('age 범위 초과 → 400', async () => {
    const token = setupAuth('guardian', GUARDIAN_ID);
    const res = await request(app)
      .post(`/api/health-profile/${GUARDIAN_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...validPayload, age: 200 });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// PUT /api/health-profile/:userId
// ────────────────────────────────────────────────────────────────
describe('PUT /api/health-profile/:userId', () => {
  test('프로필 수정 → 200 + 업데이트된 data', async () => {
    HealthProfile.create(GUARDIAN_ID, { name: '홍길동', age: 80 });
    const token = setupAuth('guardian', GUARDIAN_ID);
    const res = await request(app)
      .put(`/api/health-profile/${GUARDIAN_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ age: 81, conditions: ['고혈압', '관절염'] });
    expect(res.status).toBe(200);
    expect(res.body.data.age).toBe(81);
    expect(res.body.data.conditions).toEqual(['고혈압', '관절염']);
    expect(res.body.data.name).toBe('홍길동'); // 기존 값 유지
  });

  test('존재하지 않으면 upsert → 200', async () => {
    const token = setupAuth('guardian', 'user-new-001');
    const res = await request(app)
      .put('/api/health-profile/user-new-001')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '신규사용자' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('신규사용자');
  });
});
