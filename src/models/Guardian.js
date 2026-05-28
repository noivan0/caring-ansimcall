/**
 * src/models/Guardian.js — Guardian 보호자 도메인 모델 (재export)
 *
 * user.js에 Guardian이 통합되어 있으나, 태스크 명세(Guardian.js)에 맞게
 * 별도 파일로 re-export하고 추가 메서드를 붙인다.
 */

'use strict';

const db = require('./db');
const { Guardian: GuardianBase } = require('./user');

const Guardian = {
  ...GuardianBase,

  /**
   * 보호자가 관리하는 모든 노인 + 최신 상태 요약
   * @param {string} guardianUserId
   * @returns {Promise<Array>}
   */
  async getDashboard(guardianUserId) {
    const result = await db.query(
      `SELECT
         e.id AS elder_id,
         e.display_name,
         e.birth_date,
         r.relationship_type,
         (SELECT row_to_json(v) FROM (
           SELECT blood_pressure_systolic, blood_pressure_diastolic,
                  blood_glucose, heart_rate, recorded_at
           FROM vitals
           WHERE elder_id = e.id
           ORDER BY recorded_at DESC LIMIT 1
         ) v) AS latest_vitals,
         (SELECT json_build_object(
           'latitude', latitude, 'longitude', longitude,
           'is_in_safe_zone', is_in_safe_zone, 'updated_at', recorded_at
         ) FROM location_logs
          WHERE elder_id = e.id ORDER BY recorded_at DESC LIMIT 1) AS last_location,
         (SELECT COUNT(*)::int FROM emergency_events
          WHERE elder_id = e.id AND status = 'active') AS active_sos_count
       FROM elders e
       JOIN guardian_relationships r ON r.elder_id = e.id
       WHERE r.guardian_user_id = $1 AND r.consent_status = 'accepted'
       ORDER BY r.created_at ASC`,
      [guardianUserId]
    );
    return result.rows;
  },
};

module.exports = { Guardian };
