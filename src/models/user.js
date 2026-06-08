/**
 * src/models/user.js — User, Elder, Guardian 도메인 모델
 *
 * Prisma ORM 대신 순수 쿼리 헬퍼로 구현.
 * Prisma schema는 prisma/schema.prisma에 별도 정의.
 *
 * 모델 구조:
 *   User     — 앱 계정 (노인 본인 또는 보호자 모두 User)
 *   Elder    — User 중 '노인 프로필' (1:1)
 *   Guardian — User 중 '보호자 프로필', Elder와 N:M 관계
 *   Relationship — Guardian ↔ Elder 연결 (동의 상태 포함)
 */

'use strict';

const db = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const BCRYPT_ROUNDS = 12;

// ────────────────────────────────────────────────────────────
//  User
// ────────────────────────────────────────────────────────────

const User = {
  /**
   * 신규 사용자 생성
   * @param {object} params
   * @param {string} params.email
   * @param {string} params.phone        — E.164 형식 (+821012345678)
   * @param {string} params.password     — 평문 (해싱 후 저장)
   * @param {string} params.display_name
   * @param {'elder'|'guardian'} params.role
   * @returns {Promise<object>}          — 생성된 사용자 (password_hash 제외)
   */
  async create({ email, phone, password, display_name, role }) {
    const id = uuid();
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = await db.query(
      `INSERT INTO users
         (id, email, phone, password_hash, display_name, role, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
       RETURNING id, email, phone, display_name, role, created_at`,
      [id, email.toLowerCase(), phone, hash, display_name, role]
    );

    return result.rows[0];
  },

  /**
   * 이메일로 사용자 조회 (로그인용 — password_hash 포함)
   */
  async findByEmail(email) {
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1 AND is_deleted = false',
      [email.toLowerCase()]
    );
    return result.rows[0] || null;
  },

  /**
   * ID로 사용자 조회 (공개 필드만)
   */
  async findById(id) {
    const result = await db.query(
      `SELECT id, email, phone, display_name, role,
              profile_image_url, fcm_token, created_at
       FROM users
       WHERE id = $1 AND is_deleted = false`,
      [id]
    );
    return result.rows[0] || null;
  },

  /**
   * 관리자용 사용자 목록
   * 인증된 admin만 라우터 레이어에서 접근 가능해야 한다.
   */
  async listForAdmin() {
    const result = await db.query(
      `SELECT id, email, display_name, role, created_at
       FROM users
       WHERE is_deleted = false
       ORDER BY created_at DESC, email ASC`
    );
    return result.rows;
  },

  /**
   * FCM 토큰 갱신 (앱 재설치 시 호출)
   */
  async updateFcmToken(userId, fcmToken) {
    await db.query(
      'UPDATE users SET fcm_token = $2, updated_at = NOW() WHERE id = $1',
      [userId, fcmToken]
    );
  },

  /**
   * 비밀번호 검증
   * @returns {Promise<boolean>}
   */
  async verifyPassword(plaintext, hash) {
    return bcrypt.compare(plaintext, hash);
  },

  /**
   * GDPR/개인정보보호법 — 계정 소프트 삭제
   * 실제 레코드는 보관, 식별 정보만 익명화
   */
  async anonymize(userId) {
    const anonId = `deleted_${uuid()}`;
    await db.query(
      `UPDATE users
       SET email = $2, phone = $3, display_name = '탈퇴한 사용자',
           password_hash = '', fcm_token = NULL,
           is_deleted = true, deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [userId, `${anonId}@deleted.invalid`, anonId]
    );
  },
};

// ────────────────────────────────────────────────────────────
//  Elder
// ────────────────────────────────────────────────────────────

const Elder = {
  /**
   * 노인 프로필 생성
   * @param {string} userId
   * @param {object} profile
   * @param {string} profile.display_name
   * @param {string} profile.birth_date   — YYYY-MM-DD
   * @param {string} [profile.medical_note] — 기저질환 메모 (암호화 권장)
   */
  async create(userId, { display_name, birth_date, medical_note }) {
    const id = uuid();
    const result = await db.query(
      `INSERT INTO elders (id, user_id, display_name, birth_date, medical_note, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING id, display_name, birth_date, created_at`,
      [id, userId, display_name, birth_date, medical_note || null]
    );
    return result.rows[0];
  },

  /**
   * 보호자가 접근 가능한 노인 목록
   */
  async findByGuardian(guardianUserId) {
    const result = await db.query(
      `SELECT e.id, e.display_name, e.birth_date,
              r.relationship_type, r.consent_status, r.created_at AS linked_at
       FROM elders e
       JOIN guardian_relationships r ON r.elder_id = e.id
       JOIN users gu ON gu.id = r.guardian_user_id
       WHERE r.guardian_user_id = $1 AND r.consent_status = 'accepted'
       ORDER BY r.created_at ASC`,
      [guardianUserId]
    );
    return result.rows;
  },

  /**
   * 노인 프로필 상세
   */
  async findById(elderId) {
    const result = await db.query(
      `SELECT e.*, u.phone, u.email, u.fcm_token
       FROM elders e
       JOIN users u ON u.id = e.user_id
       WHERE e.id = $1`,
      [elderId]
    );
    return result.rows[0] || null;
  },
};

// ────────────────────────────────────────────────────────────
//  Guardian
// ────────────────────────────────────────────────────────────

const Guardian = {
  /**
   * 보호자-노인 연결 요청
   * 노인 측 동의 후 consent_status = 'accepted'로 업데이트
   *
   * @param {string} guardianUserId
   * @param {string} elderId
   * @param {'child'|'spouse'|'sibling'|'caregiver'|'other'} relationshipType
   */
  async requestRelationship(guardianUserId, elderId, relationshipType) {
    const id = uuid();
    const result = await db.query(
      `INSERT INTO guardian_relationships
         (id, guardian_user_id, elder_id, relationship_type, consent_status, created_at)
       VALUES ($1,$2,$3,$4,'pending',NOW())
       ON CONFLICT (guardian_user_id, elder_id) DO UPDATE
         SET relationship_type = EXCLUDED.relationship_type,
             consent_status = 'pending',
             updated_at = NOW()
       RETURNING *`,
      [id, guardianUserId, elderId, relationshipType]
    );
    return result.rows[0];
  },

  /**
   * 노인 본인이 동의 수락/거부
   */
  async updateConsent(relationshipId, elderUserId, status) {
    if (!['accepted', 'rejected'].includes(status)) {
      throw Object.assign(new Error('Invalid consent status'), { status: 400 });
    }

    const result = await db.query(
      `UPDATE guardian_relationships gr
       SET consent_status = $2, updated_at = NOW()
       FROM elders e
       WHERE gr.id = $1 AND gr.elder_id = e.id AND e.user_id = $3
       RETURNING gr.*`,
      [relationshipId, status, elderUserId]
    );

    if (!result.rows.length) {
      throw Object.assign(new Error('Relationship not found or unauthorized'), { status: 403 });
    }

    return result.rows[0];
  },

  /**
   * 특정 노인의 보호자 목록 (알림 발송용)
   */
  async findGuardiansByElder(elderId) {
    const result = await db.query(
      `SELECT u.id, u.display_name, u.phone, u.fcm_token, r.relationship_type
       FROM guardian_relationships r
       JOIN users u ON u.id = r.guardian_user_id
       WHERE r.elder_id = $1 AND r.consent_status = 'accepted'
       ORDER BY r.created_at ASC`,
      [elderId]
    );
    return result.rows;
  },

  /**
   * 관계 해제 — guardian_user_id + relationship ID 로 삭제
   */
  async removeRelationship(guardianUserId, relationshipId) {
    await db.query(
      `DELETE FROM guardian_relationships
       WHERE id = $1 AND guardian_user_id = $2`,
      [relationshipId, guardianUserId]
    );
  },
};

module.exports = { User, Elder, Guardian };
