/**
 * src/models/HealthProfile.js — 부모님 건강/질병 기본 정보 모델
 *
 * SQLite 기반 CRUD (PostgreSQL 폴백 불필요한 로컬 데이터)
 *
 * 테이블: health_profiles
 * 필드:
 *   userId          TEXT (FK: users.id, UNIQUE)
 *   name            TEXT
 *   age             INTEGER
 *   conditions      TEXT (JSON array: ["고혈압", "당뇨"])
 *   medications     TEXT (JSON array: ["혈압약", "혈당약"])
 *   allergies       TEXT (JSON array: ["페니실린"])
 *   doctorName      TEXT
 *   doctorPhone     TEXT
 *   bloodType       TEXT ('A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-')
 *   emergencyContact TEXT (JSON: { name, phone, relation })
 *   preferredLang   TEXT DEFAULT 'ko'  — IVR STT 언어 (ko|ja|en)
 *   ivrEnabled      INTEGER DEFAULT 1  — IVR 복약 확인 활성화 여부
 *   createdAt       TEXT (ISO8601)
 *   updatedAt       TEXT (ISO8601)
 */

'use strict';

const path    = require('path');
const Database = require('better-sqlite3');

// DB 파일 경로 (환경변수 또는 기본값)
const DB_PATH = process.env.HEALTH_PROFILE_DB_PATH
  || path.join(__dirname, '..', '..', 'data', 'health_profiles.db');

// data 디렉토리 자동 생성
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ── SQLite 연결 + 테이블 생성 ─────────────────────────────────
let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
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
        preferred_lang    TEXT DEFAULT 'ko' CHECK(preferred_lang IN ('ko','ja','en')),
        ivr_enabled       INTEGER DEFAULT 1,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      )
    `);
  }
  return _db;
}

// ── JSON 직렬화/역직렬화 헬퍼 ──────────────────────────────────
function serializeArrayField(val) {
  if (Array.isArray(val)) return JSON.stringify(val);
  if (typeof val === 'string') {
    try {
      JSON.parse(val); // 이미 JSON 문자열이면 그대로 사용
      return val;
    } catch {
      return '[]';
    }
  }
  return '[]';
}

function serializeObjectField(val) {
  if (val === null || val === undefined) return '{}';
  if (typeof val === 'object') return JSON.stringify(val);
  if (typeof val === 'string') {
    try { JSON.parse(val); return val; } catch { return '{}'; }
  }
  return '{}';
}

/**
 * DB row → API 응답 객체 변환
 */
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
    preferredLang:    row.preferred_lang || 'ko',
    ivrEnabled:       row.ivr_enabled !== 0,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

// ── HealthProfile CRUD ────────────────────────────────────────

const HealthProfile = {

  /**
   * 건강 프로필 조회
   * @param {string} userId
   * @returns {object|null}
   */
  findByUserId(userId) {
    const db  = getDb();
    const row = db.prepare('SELECT * FROM health_profiles WHERE user_id = ?').get(userId);
    return rowToProfile(row);
  },

  /**
   * 건강 프로필 생성
   * @param {string} userId
   * @param {object} data
   * @returns {object} 생성된 프로필
   */
  create(userId, data) {
    const db  = getDb();
    const now = new Date().toISOString();

    const {
      name, age, conditions, medications, allergies,
      doctorName, doctorPhone, bloodType, emergencyContact,
      preferredLang, ivrEnabled,
    } = data;

    db.prepare(`
      INSERT INTO health_profiles
        (user_id, name, age, conditions, medications, allergies,
         doctor_name, doctor_phone, blood_type, emergency_contact,
         preferred_lang, ivr_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      name             || null,
      age              || null,
      serializeArrayField(conditions),
      serializeArrayField(medications),
      serializeArrayField(allergies),
      doctorName       || null,
      doctorPhone      || null,
      bloodType        || null,
      serializeObjectField(emergencyContact),
      ['ko','ja','en'].includes(preferredLang) ? preferredLang : 'ko',
      ivrEnabled === false ? 0 : 1,
      now, now
    );

    return this.findByUserId(userId);
  },

  /**
   * 건강 프로필 수정 (upsert)
   * @param {string} userId
   * @param {object} data
   * @returns {object} 수정된 프로필
   */
  update(userId, data) {
    const db  = getDb();
    const now = new Date().toISOString();

    const existing = this.findByUserId(userId);
    if (!existing) {
      // 없으면 생성
      return this.create(userId, data);
    }

    const {
      name, age, conditions, medications, allergies,
      doctorName, doctorPhone, bloodType, emergencyContact,
    } = data;

    db.prepare(`
      UPDATE health_profiles SET
        name              = COALESCE(?, name),
        age               = COALESCE(?, age),
        conditions        = COALESCE(?, conditions),
        medications       = COALESCE(?, medications),
        allergies         = COALESCE(?, allergies),
        doctor_name       = COALESCE(?, doctor_name),
        doctor_phone      = COALESCE(?, doctor_phone),
        blood_type        = COALESCE(?, blood_type),
        emergency_contact = COALESCE(?, emergency_contact),
        updated_at        = ?
      WHERE user_id = ?
    `).run(
      name             !== undefined ? name       : null,
      age              !== undefined ? age        : null,
      conditions       !== undefined ? serializeArrayField(conditions)       : null,
      medications      !== undefined ? serializeArrayField(medications)      : null,
      allergies        !== undefined ? serializeArrayField(allergies)        : null,
      doctorName       !== undefined ? doctorName : null,
      doctorPhone      !== undefined ? doctorPhone : null,
      bloodType        !== undefined ? bloodType  : null,
      emergencyContact !== undefined ? serializeObjectField(emergencyContact) : null,
      now,
      userId
    );

    return this.findByUserId(userId);
  },

  /**
   * 건강 프로필 삭제
   * @param {string} userId
   * @returns {boolean}
   */
  delete(userId) {
    const db     = getDb();
    const result = db.prepare('DELETE FROM health_profiles WHERE user_id = ?').run(userId);
    return result.changes > 0;
  },

  // 테스트용: DB 인스턴스 초기화 (메모리 DB 교체)
  _resetDb(newDb) {
    _db = newDb;
  },

  _getDb: getDb,
};

module.exports = { HealthProfile };
