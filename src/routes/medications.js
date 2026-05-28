/**
 * src/routes/medications.js — 복약 알림 라우터 (스텁)
 *
 * GET    /api/v1/medications/elder/:elderId              — 복약 스케줄 목록
 * POST   /api/v1/medications/elder/:elderId              — 스케줄 등록
 * PATCH  /api/v1/medications/elder/:elderId/:scheduleId  — 스케줄 수정
 * DELETE /api/v1/medications/elder/:elderId/:scheduleId  — 스케줄 삭제
 * POST   /api/v1/medications/elder/:elderId/log          — 복약 완료 기록 (노인 앱 → 보호자 알림)
 * GET    /api/v1/medications/elder/:elderId/log          — 복약 이력
 */

'use strict';

const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { checkRelationship } = require('../middleware/relationship');
const db = require('../models/db');
const { notifyGuardians } = require('../services/notificationService');

router.use(authenticate);

// ── GET 스케줄 ───────────────────────────────────────────────
router.get('/elder/:elderId', [param('elderId').isUUID()], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

  await checkRelationship(req, res, async () => {
    const result = await db.query(
      `SELECT id, medication_name, dosage, frequency, scheduled_times, is_active, created_at
       FROM medication_schedules
       WHERE elder_id = $1 AND is_active = true
       ORDER BY created_at ASC`,
      [req.params.elderId]
    );
    res.json({ data: result.rows });
  });
}));

// ── POST 스케줄 등록 ─────────────────────────────────────────
router.post(
  '/elder/:elderId',
  [
    param('elderId').isUUID(),
    body('medication_name').isString().trim().isLength({ min: 1, max: 100 }),
    body('dosage').isString().trim().isLength({ min: 1, max: 50 }),
    body('frequency').isIn(['daily', 'twice_daily', 'three_times', 'weekly', 'as_needed']),
    body('scheduled_times').isArray({ min: 1 }),
    body('scheduled_times.*').matches(/^([01]\d|2[0-3]):[0-5]\d$/), // HH:MM
  ],
  requireRole('guardian'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const { medication_name, dosage, frequency, scheduled_times } = req.body;

      const result = await db.query(
        `INSERT INTO medication_schedules
           (elder_id, medication_name, dosage, frequency, scheduled_times, created_by)
         VALUES ($1,$2,$3,$4,$5::text[],$6)
         RETURNING *`,
        [elderId, medication_name, dosage, frequency, scheduled_times, req.user.id]
      );

      res.status(201).json({ data: result.rows[0] });
    });
  })
);

// ── POST 복약 완료 로그 ──────────────────────────────────────
// 노인 본인이 복약 완료 버튼 → 보호자 푸시 알림
router.post(
  '/elder/:elderId/log',
  [
    param('elderId').isUUID(),
    body('schedule_id').isUUID(),
    body('taken_at').optional().isISO8601(),
    body('status').optional().isIn(['taken', 'skipped', 'missed']),
    body('note').optional().isString().isLength({ max: 200 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const { schedule_id, taken_at, note, status } = req.body;

      const result = await db.query(
        `INSERT INTO medication_logs
           (elder_id, schedule_id, taken_at, note, logged_by, status)
         VALUES ($1,$2, COALESCE($3::timestamptz, NOW()), $4, $5, COALESCE($6, 'taken'))
         RETURNING *`,
        [elderId, schedule_id, taken_at || null, note || null, req.user.id, status || 'taken']
      );

      // 보호자 알림 (비동기)
      notifyGuardians(elderId, {
        type: 'MEDICATION_TAKEN',
        scheduleId: schedule_id,
        takenAt: result.rows[0].taken_at,
      }).catch(console.error);

      res.status(201).json({ data: result.rows[0] });
    });
  })
);

// ── GET 복약 이력 ────────────────────────────────────────────
router.get('/elder/:elderId/log', [param('elderId').isUUID()], asyncHandler(async (req, res) => {
  await checkRelationship(req, res, async () => {
    const result = await db.query(
      `SELECT ml.*, ms.medication_name
       FROM medication_logs ml
       JOIN medication_schedules ms ON ms.id = ml.schedule_id
       WHERE ml.elder_id = $1
       ORDER BY ml.taken_at DESC
       LIMIT 100`,
      [req.params.elderId]
    );
    res.json({ data: result.rows });
  });
}));

module.exports = router;
