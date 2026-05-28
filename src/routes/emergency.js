/**
 * src/routes/emergency.js — 응급 SOS 라우터
 *
 * POST /api/v1/emergency/elder/:elderId/sos     — SOS 트리거 (노인 → 119 + 보호자 동시)
 * GET  /api/v1/emergency/elder/:elderId/history — SOS 이력
 * POST /api/v1/emergency/elder/:elderId/resolve — SOS 해제 (상황 종료)
 */

'use strict';

const router = require('express').Router();
const { param, body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { checkRelationship } = require('../middleware/relationship');
const db = require('../models/db');
const { notifyGuardians } = require('../services/notificationService');
const { trigger119 } = require('../services/emergencyService');

router.use(authenticate);

// ── POST /emergency/elder/:elderId/sos ───────────────────────
// 노인이 SOS 버튼을 누름
// 1) DB에 SOS 이벤트 기록
// 2) 보호자 전원 즉시 푸시 알림
// 3) 119 API 연동 (비동기, 실패해도 보호자 알림은 전달)
router.post(
  '/elder/:elderId/sos',
  [
    param('elderId').isUUID(),
    body('latitude').optional().isFloat(),
    body('longitude').optional().isFloat(),
    body('trigger_type').optional().isIn(['button', 'fall_detected', 'no_movement']),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const { latitude, longitude, trigger_type = 'button' } = req.body;

      // SOS 이벤트 기록
      const result = await db.query(
        `INSERT INTO emergency_events
           (elder_id, trigger_type, latitude, longitude, status, triggered_by, triggered_at)
         VALUES ($1,$2,$3,$4,'active',$5,NOW())
         RETURNING *`,
        [elderId, trigger_type, latitude || null, longitude || null, req.user.id]
      );

      const event = result.rows[0];

      // 보호자 동시 알림 (최우선 — await)
      await notifyGuardians(elderId, {
        type: 'SOS_TRIGGERED',
        eventId: event.id,
        triggerType: trigger_type,
        location: latitude ? { latitude, longitude } : null,
        triggeredAt: event.triggered_at,
      });

      // 119 연동 (비동기 — 외부 API 지연이 응답을 막지 않도록)
      trigger119({
        elderId,
        eventId: event.id,
        latitude,
        longitude,
      }).catch(err => console.error('[119 연동 실패]', err.message));

      // Socket.IO 실시간 알림 (보호자 앱 화면 강제 이동)
      const io = req.app.get('io');
      if (io) {
        io.to(`guardian:${elderId}`).emit('sos:triggered', {
          elderId,
          eventId: event.id,
          location: { latitude, longitude },
        });
      }

      res.status(201).json({ data: event });
    });
  })
);

// ── GET /emergency/elder/:elderId/history ────────────────────
router.get(
  '/elder/:elderId/history',
  [param('elderId').isUUID()],
  asyncHandler(async (req, res) => {
    await checkRelationship(req, res, async () => {
      const result = await db.query(
        `SELECT ee.*, u.display_name AS responder_name
         FROM emergency_events ee
         LEFT JOIN users u ON u.id = ee.resolved_by
         WHERE ee.elder_id = $1
         ORDER BY ee.triggered_at DESC
         LIMIT 50`,
        [req.params.elderId]
      );
      res.json({ data: result.rows });
    });
  })
);

// ── POST /emergency/elder/:elderId/resolve ───────────────────
router.post(
  '/elder/:elderId/resolve',
  [
    param('elderId').isUUID(),
    body('event_id').isUUID(),
    body('note').optional().isString().isLength({ max: 300 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { event_id, note } = req.body;

      const result = await db.query(
        `UPDATE emergency_events
         SET status = 'resolved', resolved_by = $2, resolve_note = $3, resolved_at = NOW()
         WHERE id = $1 AND elder_id = $4
         RETURNING *`,
        [event_id, req.user.id, note || null, req.params.elderId]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'EVENT_NOT_FOUND' });
      }

      // Socket.IO로 해제 브로드캐스트
      const io = req.app.get('io');
      if (io) {
        io.to(`guardian:${req.params.elderId}`).emit('sos:resolved', {
          eventId: event_id,
          resolvedBy: req.user.display_name,
        });
      }

      res.json({ data: result.rows[0] });
    });
  })
);

module.exports = router;
