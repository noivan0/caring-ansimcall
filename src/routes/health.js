/**
 * src/routes/health.js — 건강 데이터 라우터
 *
 * 엔드포인트:
 *   GET  /api/v1/health/elder/:elderId          — 최근 건강 요약
 *   POST /api/v1/health/elder/:elderId/vitals   — 바이탈 기록 (기기 연동)
 *   GET  /api/v1/health/elder/:elderId/history  — 기간별 이력
 *   PUT  /api/v1/health/elder/:elderId/thresholds — 알림 임계값 설정
 */

'use strict';

const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { checkRelationship } = require('../middleware/relationship');
const db = require('../models/db');
const { notifyGuardians, saveNotification } = require('../services/notificationService');

// ── 인증 + 관계 검증 미들웨어 적용 ──────────────────────────
router.use(authenticate);
router.use('/:elderId', (req, _res, next) => {
  req.params.elderId = req.params.elderId;
  next();
});

// ── GET /health/elder/:elderId ───────────────────────────────
// 오늘의 건강 요약 (보호자 앱 메인 카드)
router.get(
  '/elder/:elderId',
  [param('elderId').isUUID()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;

      const summary = await db.query(
        `SELECT
           e.id,
           e.display_name,
           (SELECT row_to_json(v) FROM (
             SELECT blood_pressure_systolic, blood_pressure_diastolic,
                    blood_glucose, heart_rate, steps, recorded_at
             FROM vitals
             WHERE elder_id = $1
             ORDER BY recorded_at DESC
             LIMIT 1
           ) v) AS latest_vitals,
           (SELECT COUNT(*)::int FROM medication_logs
            WHERE elder_id = $1 AND taken_at::date = CURRENT_DATE) AS meds_taken_today,
           (SELECT COUNT(*)::int FROM medication_schedules
            WHERE elder_id = $1 AND is_active = true) AS meds_scheduled_today,
           (SELECT json_build_object(
             'latitude', latitude, 'longitude', longitude, 'updated_at', recorded_at,
             'is_in_safe_zone', is_in_safe_zone
           ) FROM location_logs
            WHERE elder_id = $1 ORDER BY recorded_at DESC LIMIT 1) AS last_location
         FROM elders e
         WHERE e.id = $1`,
        [elderId]
      );

      if (!summary.rows.length) {
        return res.status(404).json({ error: 'ELDER_NOT_FOUND' });
      }

      res.json({ data: summary.rows[0] });
    });
  })
);

// ── POST /health/elder/:elderId/vitals ───────────────────────
// 바이탈 기록 (스마트워치/혈압계 SDK 연동)
router.post(
  '/elder/:elderId/vitals',
  [
    param('elderId').isUUID(),
    body('blood_pressure_systolic').optional().isInt({ min: 60, max: 250 }),
    body('blood_pressure_diastolic').optional().isInt({ min: 40, max: 150 }),
    body('blood_glucose').optional().isFloat({ min: 50, max: 600 }),
    body('heart_rate').optional().isInt({ min: 30, max: 250 }),
    body('steps').optional().isInt({ min: 0 }),
    body('source').isIn(['smartwatch', 'blood_pressure_cuff', 'glucometer', 'manual', 'app']),
    body('recorded_at').optional().isISO8601(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const {
        blood_pressure_systolic, blood_pressure_diastolic,
        blood_glucose, heart_rate, steps,
        source, recorded_at,
      } = req.body;

      const result = await db.query(
        `INSERT INTO vitals
           (elder_id, blood_pressure_systolic, blood_pressure_diastolic,
            blood_glucose, heart_rate, steps, source, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, NOW()))
         RETURNING *`,
        [elderId, blood_pressure_systolic, blood_pressure_diastolic,
         blood_glucose, heart_rate, steps, source, recorded_at]
      );

      const vital = result.rows[0];

      // 임계값 초과 시 보호자 알림 (비동기 — 응답을 블로킹하지 않음)
      checkThresholdsAndNotify(elderId, vital).catch(err => {
        console.error('[health] checkThresholdsAndNotify 실패:', err.message);
        // 실패 이력 DB 기록 (silent failure 방지)
        saveNotification(
          elderId,
          'NOTIFICATION_FAILURE',
          '임계값 초과 알림 실패',
          err.message,
          { route: 'health', event: 'HEALTH_ALERT', elderId, failedAt: new Date().toISOString() }
        ).catch(dbErr => console.error('[health] 실패 이력 DB 기록 오류:', dbErr.message));
      });

      res.status(201).json({ data: vital });
    });
  })
);

// ── GET /health/elder/:elderId/history ───────────────────────
// 기간별 건강 이력 (그래프용)
router.get(
  '/elder/:elderId/history',
  [
    param('elderId').isUUID(),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('type').optional().isIn(['vitals', 'steps', 'all']),
    query('limit').optional().isInt({ min: 1, max: 1000 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const { from, to, limit = 100 } = req.query;

      const history = await db.query(
        `SELECT * FROM vitals
         WHERE elder_id = $1
           AND ($2::timestamptz IS NULL OR recorded_at >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR recorded_at <= $3::timestamptz)
         ORDER BY recorded_at DESC
         LIMIT $4`,
        [elderId, from || null, to || null, limit]
      );

      res.json({ data: history.rows, count: history.rowCount });
    });
  })
);

// ── PUT /health/elder/:elderId/thresholds ────────────────────
// 보호자가 알림 임계값 설정
router.put(
  '/elder/:elderId/thresholds',
  [
    param('elderId').isUUID(),
    body('blood_pressure_systolic_max').optional().isInt({ min: 100, max: 250 }),
    body('blood_pressure_systolic_min').optional().isInt({ min: 60, max: 150 }),
    body('heart_rate_max').optional().isInt({ min: 60, max: 250 }),
    body('heart_rate_min').optional().isInt({ min: 30, max: 80 }),
    body('blood_glucose_max').optional().isFloat({ min: 100, max: 600 }),
  ],
  requireRole('guardian'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const thresholds = req.body;

      // UPSERT — 없으면 생성, 있으면 갱신
      const result = await db.query(
        `INSERT INTO health_thresholds (elder_id, settings, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (elder_id) DO UPDATE
           SET settings = $2::jsonb, updated_at = NOW()
         RETURNING *`,
        [elderId, JSON.stringify(thresholds)]
      );

      res.json({ data: result.rows[0] });
    });
  })
);

// ── 내부 함수 ────────────────────────────────────────────────

async function checkThresholdsAndNotify(elderId, vital) {
  const thRow = await db.query(
    'SELECT settings FROM health_thresholds WHERE elder_id = $1',
    [elderId]
  );

  if (!thRow.rows.length) return;

  const th = thRow.rows[0].settings;
  const alerts = [];

  if (th.blood_pressure_systolic_max && vital.blood_pressure_systolic > th.blood_pressure_systolic_max) {
    alerts.push({ type: 'HIGH_BLOOD_PRESSURE', value: vital.blood_pressure_systolic });
  }
  if (th.heart_rate_max && vital.heart_rate > th.heart_rate_max) {
    alerts.push({ type: 'HIGH_HEART_RATE', value: vital.heart_rate });
  }

  if (alerts.length > 0) {
    await notifyGuardians(elderId, { type: 'HEALTH_ALERT', alerts, vital });
  }
}

module.exports = router;
