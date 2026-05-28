/**
 * src/models/Elder.js — Elder 프로필 도메인 모델 (재export)
 *
 * user.js에 Elder가 통합되어 있으나, 태스크 명세(Elder.js)에 맞게
 * 별도 파일로 re-export하고 추가 메서드를 붙인다.
 */

'use strict';

const db = require('./db');
const { Elder: ElderBase } = require('./user');

const Elder = {
  ...ElderBase,

  /**
   * 노인 정보 업데이트
   * @param {string} elderId
   * @param {object} fields — { display_name?, medical_note? }
   */
  async update(elderId, fields) {
    const setClauses = [];
    const values     = [];
    let   idx        = 1;

    if (fields.display_name) {
      setClauses.push(`display_name = $${idx++}`);
      values.push(fields.display_name);
    }
    if (fields.medical_note !== undefined) {
      setClauses.push(`medical_note = $${idx++}`);
      values.push(fields.medical_note);
    }
    if (!setClauses.length) return;

    values.push(elderId);
    await db.query(
      `UPDATE elders SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      values
    );
  },

  /**
   * FCM 토큰 조회 (알림 발송용)
   * @param {string} elderId
   * @returns {Promise<string|null>}
   */
  async getFcmToken(elderId) {
    const result = await db.query(
      `SELECT u.fcm_token FROM elders e JOIN users u ON u.id = e.user_id WHERE e.id = $1`,
      [elderId]
    );
    return result.rows[0]?.fcm_token || null;
  },
};

module.exports = { Elder };
