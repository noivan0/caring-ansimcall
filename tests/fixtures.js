/**
 * tests/fixtures.js — 테스트 공용 픽스처
 *
 * - makeToken(role, userId) : 테스트용 JWT 발급
 * - fakeUUID()              : 재현 가능한 UUID 목록
 * - getMockDb()             : jest.mock된 db 인스턴스 반환
 */

'use strict';

const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const SECRET         = 'test-secret-key-1234567890';
const REFRESH_SECRET = 'test-refresh-secret-1234567890';

// 테스트 환경 공통 환경변수 설정
process.env.JWT_SECRET         = SECRET;
process.env.JWT_REFRESH_SECRET = REFRESH_SECRET;
process.env.NODE_ENV           = 'test';

/**
 * 테스트용 Access JWT 생성
 * @param {'elder'|'guardian'|'admin'} role
 * @param {string} [userId]
 */
function makeToken(role = 'guardian', userId = uuid()) {
  return jwt.sign(
    { sub: userId, type: 'access', role },
    SECRET,
    { expiresIn: '1h', issuer: 'senior-care' }
  );
}

/**
 * 테스트용 Refresh JWT 생성
 */
function makeRefreshToken(userId = uuid()) {
  return jwt.sign(
    { sub: userId, type: 'refresh' },
    REFRESH_SECRET,
    { expiresIn: '30d', issuer: 'senior-care' }
  );
}

/** 고정 UUID 생성기 (테스트 가독성용) */
const UUIDS = {
  elder1:    '11111111-1111-1111-1111-111111111111',
  elder2:    '22222222-2222-2222-2222-222222222222',
  guardian1: '33333333-3333-3333-3333-333333333333',
  guardian2: '44444444-4444-4444-4444-444444444444',
  event1:    '55555555-5555-5555-5555-555555555555',
  zone1:     '66666666-6666-6666-6666-666666666666',
  sched1:    '77777777-7777-7777-7777-777777777777',
};

/**
 * mock db 인스턴스 접근 헬퍼
 * jest.mock이 등록된 후 호출해야 한다.
 */
function getMockDb() {
  return require('../src/models/db');
}

/**
 * mock db.query를 특정 결과로 초기화
 * @param {object[]} rows — DB 응답 rows
 * @param {number}   [rowCount]
 */
function mockDbQuery(rows = [], rowCount) {
  const db = getMockDb();
  db.query.mockResolvedValue({
    rows,
    rowCount: rowCount ?? rows.length,
  });
}

/**
 * db.query를 순서대로 다른 결과를 반환하도록 설정
 * @param {...object[]} rowSets — 순서대로 반환할 rows 배열들
 */
function mockDbQuerySequence(...rowSets) {
  const db = getMockDb();
  const mock = db.query;
  mock.mockReset();
  for (const rows of rowSets) {
    if (rows instanceof Error) {
      mock.mockRejectedValueOnce(rows);
    } else {
      mock.mockResolvedValueOnce({ rows, rowCount: rows.length });
    }
  }
}

/**
 * 인증 통과를 위한 표준 사용자 객체 (User.findById mock용)
 */
function fakeUser(override = {}) {
  return {
    id:           UUIDS.guardian1,
    email:        'guardian@test.com',
    phone:        '+821012345678',
    display_name: '테스트보호자',
    role:         'guardian',
    fcm_token:    null,
    created_at:   new Date().toISOString(),
    ...override,
  };
}

function fakeElder(override = {}) {
  return {
    id:           UUIDS.elder1,
    user_id:      UUIDS.elder1 + '-u',
    display_name: '테스트노인',
    medical_note: null,
    created_at:   new Date().toISOString(),
    ...override,
  };
}

module.exports = {
  SECRET,
  REFRESH_SECRET,
  UUIDS,
  makeToken,
  makeRefreshToken,
  getMockDb,
  mockDbQuery,
  mockDbQuerySequence,
  fakeUser,
  fakeElder,
};
