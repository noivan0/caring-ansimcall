/**
 * src/models/HealthRecord.js — 건강 기록 도메인 모델
 *
 * 역할:
 *   - vitals INSERT / 이력 조회
 *   - 임계값 이상 감지 (checkThresholds)
 *   - 복약 스케줄 관련 쿼리
 */

'use strict';

const db = require('./db');

// ── 혈압/혈당/심박 임계값 기본값 ────────────────────────────
const DEFAULT_THRESHOLDS = {
  blood_pressure_systolic_max:  160,
  blood_pressure_systolic_min:  80,
  blood_pressure_diastolic_max: 100,
  blood_pressure_diastolic_min: 50,
  heart_rate_max: 120,
  heart_rate_min: 50,
  blood_glucose_max: 126,
  blood_glucose_min: 70,
};

const HealthRecord = {
  /**
   * 바이탈 기록 삽입
   * @param {string} elderId
   * @param {object} vital
   * @returns {Promise<object>} 삽입된 레코드
   */
  async insertVital(elderId, vital) {
    const {
      blood_pressure_systolic, blood_pressure_diastolic,
      blood_glucose, heart_rate, steps,
      source, recorded_at,
    } = vital;

    const result = await db.query(
      `INSERT INTO vitals
         (elder_id, blood_pressure_systolic, blood_pressure_diastolic,
          blood_glucose, heart_rate, steps, source, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, NOW()))
       RETURNING *`,
      [elderId, blood_pressure_systolic || null, blood_pressure_diastolic || null,
       blood_glucose || null, heart_rate || null, steps || null,
       source, recorded_at || null]
    );
    return result.rows[0];
  },

  /**
   * 기간별 이력 조회
   * @param {string} elderId
   * @param {object} opts  — { from, to, limit }
   * @returns {Promise<Array>}
   */
  async getHistory(elderId, { from, to, limit = 100 } = {}) {
    const result = await db.query(
      `SELECT * FROM vitals
       WHERE elder_id = $1
         AND ($2::timestamptz IS NULL OR recorded_at >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR recorded_at <= $3::timestamptz)
       ORDER BY recorded_at DESC
       LIMIT $4`,
      [elderId, from || null, to || null, limit]
    );
    return result.rows;
  },

  /**
   * 임계값 초과 항목 반환 (보호자 알림 트리거용)
   * @param {object} vital   — DB에서 조회한 바이탈 레코드
   * @param {object} [th]    — health_thresholds.settings 또는 기본값
   * @returns {Array}        — 초과 항목 배열 [{ type, value, limit }]
   */
  checkThresholds(vital, th = DEFAULT_THRESHOLDS) {
    const alerts = [];

    const check = (field, type, limit, isMax) => {
      const val = vital[field];
      if (val == null || limit == null) return;
      if (isMax ? val > limit : val < limit) {
        alerts.push({ type, value: val, limit });
      }
    };

    check('blood_pressure_systolic', 'HIGH_SYSTOLIC_BP',  th.blood_pressure_systolic_max,  true);
    check('blood_pressure_systolic', 'LOW_SYSTOLIC_BP',   th.blood_pressure_systolic_min,  false);
    check('blood_pressure_diastolic','HIGH_DIASTOLIC_BP', th.blood_pressure_diastolic_max, true);
    check('blood_pressure_diastolic','LOW_DIASTOLIC_BP',  th.blood_pressure_diastolic_min, false);
    check('heart_rate',              'HIGH_HEART_RATE',   th.heart_rate_max,               true);
    check('heart_rate',              'LOW_HEART_RATE',    th.heart_rate_min,               false);
    check('blood_glucose',           'HIGH_BLOOD_GLUCOSE',th.blood_glucose_max,            true);
    check('blood_glucose',           'LOW_BLOOD_GLUCOSE', th.blood_glucose_min,            false);

    return alerts;
  },

  /**
   * 노인별 임계값 설정 조회
   * @param {string} elderId
   * @returns {Promise<object>} thresholds or default
   */
  async getThresholds(elderId) {
    const result = await db.query(
      'SELECT settings FROM health_thresholds WHERE elder_id = $1',
      [elderId]
    );
    return result.rows[0]?.settings || DEFAULT_THRESHOLDS;
  },
};

module.exports = { HealthRecord, DEFAULT_THRESHOLDS };
