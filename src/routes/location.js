/**
 * src/routes/location.js — 위치 공유 라우터
 *
 * 엔드포인트:
 *   POST /api/v1/location/elder/:elderId           — 위치 업데이트 (앱 → 서버)
 *   GET  /api/v1/location/elder/:elderId/current   — 현재 위치 조회
 *   GET  /api/v1/location/elder/:elderId/history   — 이동 이력
 *   POST /api/v1/location/elder/:elderId/safe-zones — 안전구역 등록
 *   GET  /api/v1/location/elder/:elderId/safe-zones — 안전구역 목록
 *   DELETE /api/v1/location/elder/:elderId/safe-zones/:zoneId — 삭제
 */

'use strict';

const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { checkRelationship } = require('../middleware/relationship');
const db = require('../models/db');
const { notifyGuardians, saveNotification } = require('../services/notificationService');

router.use(authenticate);

// ── POST /location/elder/:elderId ────────────────────────────
// 노인 앱에서 주기적으로 위치를 서버에 전송
router.post(
  '/elder/:elderId',
  [
    param('elderId').isUUID(),
    body('latitude').isFloat({ min: 33.0, max: 43.0 }),   // 대한민국 위도 범위
    body('longitude').isFloat({ min: 124.0, max: 132.0 }), // 대한민국 경도 범위
    body('accuracy').optional().isFloat({ min: 0 }),
    body('altitude').optional().isFloat(),
    body('speed').optional().isFloat({ min: 0 }),
    body('recorded_at').optional().isISO8601(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const { latitude, longitude, accuracy, altitude, speed, recorded_at } = req.body;

      // 안전구역 확인 (PostGIS 미설치 시 폴백: haversine 거리 계산)
      let isInSafeZone = true; // 기본값: 안전
      let exitedZone = null;
      try {
        const safeZoneCheck = await db.query(
          `SELECT id, name, latitude, longitude, radius_meters
           FROM safe_zones
           WHERE elder_id = $1 AND is_active = true`,
          [elderId]
        );
        if (safeZoneCheck.rows.length > 0) {
          // Haversine 거리 계산
          const toRad = d => d * Math.PI / 180;
          const R = 6371000; // 지구 반지름 (m)
          const results = safeZoneCheck.rows.map(zone => {
            const dLat = toRad(latitude - zone.latitude);
            const dLon = toRad(longitude - zone.longitude);
            const a = Math.sin(dLat/2)**2 + Math.cos(toRad(latitude)) * Math.cos(toRad(zone.latitude)) * Math.sin(dLon/2)**2;
            const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            return { ...zone, is_inside: dist <= zone.radius_meters };
          });
          isInSafeZone = results.some(z => z.is_inside);
          exitedZone = results.find(z => !z.is_inside) || null;
        }
      } catch (_e) {
        // PostGIS/DB 오류 시 위치 기록만 저장
      }

      // 위치 기록 저장
      const result = await db.query(
        `INSERT INTO location_logs
           (elder_id, latitude, longitude, accuracy, altitude, speed, is_in_safe_zone, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, NOW()))
         RETURNING *`,
        [elderId, latitude, longitude, accuracy, altitude, speed, isInSafeZone, recorded_at]
      );

      // 안전구역 이탈 알림 (비동기)
      if (!isInSafeZone && exitedZone) {
        notifyGuardians(elderId, {
          type: 'SAFE_ZONE_EXIT',
          zoneName: exitedZone.name,
          location: { latitude, longitude },
        }).catch(err => {
          console.error('[location] notifyGuardians SAFE_ZONE_EXIT 실패:', err.message);
          // 실패 이력 DB 기록 (silent failure 방지)
          saveNotification(
            elderId,
            'NOTIFICATION_FAILURE',
            '안전구역 이탈 알림 실패',
            err.message,
            { route: 'location', event: 'SAFE_ZONE_EXIT', elderId, zoneName: exitedZone.name, failedAt: new Date().toISOString() }
          ).catch(dbErr => console.error('[location] 실패 이력 DB 기록 오류:', dbErr.message));
        });
      }

      // Socket.IO로 실시간 위치 브로드캐스트
      const io = req.app.get('io');
      if (io) {
        io.to(`guardian:${elderId}`).emit('location:update', {
          elderId,
          latitude,
          longitude,
          isInSafeZone,
          ts: Date.now(),
        });
      }

      res.status(201).json({ data: result.rows[0], isInSafeZone });
    });
  })
);

// ── GET /location/elder/:elderId/current ─────────────────────
router.get(
  '/elder/:elderId/current',
  [param('elderId').isUUID()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;

      const result = await db.query(
        `SELECT l.*, e.display_name AS elder_name
         FROM location_logs l
         JOIN elders e ON e.id = l.elder_id
         WHERE l.elder_id = $1
         ORDER BY l.recorded_at DESC
         LIMIT 1`,
        [elderId]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'NO_LOCATION_DATA' });
      }

      res.json({ data: result.rows[0] });
    });
  })
);

// ── GET /location/elder/:elderId/history ─────────────────────
router.get(
  '/elder/:elderId/history',
  [
    param('elderId').isUUID(),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('limit').optional().isInt({ min: 1, max: 500 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const { from, to, limit = 200 } = req.query;

      const result = await db.query(
        `SELECT latitude, longitude, is_in_safe_zone, recorded_at
         FROM location_logs
         WHERE elder_id = $1
           AND ($2::timestamptz IS NULL OR recorded_at >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR recorded_at <= $3::timestamptz)
         ORDER BY recorded_at DESC
         LIMIT $4`,
        [elderId, from || null, to || null, limit]
      );

      res.json({ data: result.rows, count: result.rowCount });
    });
  })
);

// ── POST /location/elder/:elderId/safe-zones ─────────────────
// 보호자가 안전구역 등록 (집, 병원, 마트 등)
router.post(
  '/elder/:elderId/safe-zones',
  [
    param('elderId').isUUID(),
    body('name').isString().trim().isLength({ min: 1, max: 50 }),
    body('latitude').isFloat({ min: 33.0, max: 43.0 }),
    body('longitude').isFloat({ min: 124.0, max: 132.0 }),
    body('radius_meters').isInt({ min: 50, max: 5000 }),
    body('icon').optional().isIn(['home', 'hospital', 'store', 'park', 'other']),
  ],
  requireRole('guardian'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;
      const { name, latitude, longitude, radius_meters, icon = 'other' } = req.body;

      const result = await db.query(
        `INSERT INTO safe_zones
           (elder_id, name, latitude, longitude, radius_meters, icon, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, latitude, longitude, radius_meters, icon, is_active, created_at`,
        [elderId, name, latitude, longitude, radius_meters, icon, req.user.id]
      );

      res.status(201).json({ data: result.rows[0] });
    });
  })
);

// ── GET /location/elder/:elderId/safe-zones ──────────────────
router.get(
  '/elder/:elderId/safe-zones',
  [param('elderId').isUUID()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId } = req.params;

      const result = await db.query(
        `SELECT id, name, radius_meters, icon, is_active,
                latitude,
                longitude,
                created_at
         FROM safe_zones
         WHERE elder_id = $1 AND is_active = true
         ORDER BY created_at ASC`,
        [elderId]
      );

      res.json({ data: result.rows });
    });
  })
);

// ── DELETE /location/elder/:elderId/safe-zones/:zoneId ───────
router.delete(
  '/elder/:elderId/safe-zones/:zoneId',
  [param('elderId').isUUID(), param('zoneId').isUUID()],
  requireRole('guardian'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    await checkRelationship(req, res, async () => {
      const { elderId, zoneId } = req.params;

      await db.query(
        `UPDATE safe_zones SET is_active = false
         WHERE id = $1 AND elder_id = $2`,
        [zoneId, elderId]
      );

      res.status(204).send();
    });
  })
);

module.exports = router;
