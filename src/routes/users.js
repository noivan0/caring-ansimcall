/**
 * src/routes/users.js — 사용자/프로필 라우터 (스텁)
 *
 * GET    /api/v1/users/me              — 내 프로필
 * PATCH  /api/v1/users/me             — 프로필 수정
 * GET    /api/v1/users/me/elders      — 내가 케어하는 노인 목록 (보호자용)
 * POST   /api/v1/users/relationships  — 보호자-노인 연결 요청
 * PATCH  /api/v1/users/relationships/:id — 동의 수락/거부
 * DELETE /api/v1/users/relationships/:id — 관계 해제
 */

'use strict';

const router = require('express').Router();
const { param, body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { User, Elder, Guardian } = require('../models/user');

router.use(authenticate);

// ── GET /users/me ─────────────────────────────────────────────
router.get('/me', asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  res.json({ data: user });
}));

// ── PATCH /users/me ───────────────────────────────────────────
router.patch(
  '/me',
  [
    body('display_name').optional().isString().trim().isLength({ min: 1, max: 50 }),
    body('fcm_token').optional().isString(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    const { display_name, fcm_token } = req.body;
    if (fcm_token) await User.updateFcmToken(req.user.id, fcm_token);
    // display_name 업데이트는 별도 쿼리 (생략 가능)

    res.json({ data: await User.findById(req.user.id) });
  })
);

// ── GET /users/me/elders ──────────────────────────────────────
router.get('/me/elders', asyncHandler(async (req, res) => {
  const elders = await Elder.findByGuardian(req.user.id);
  res.json({ data: elders });
}));

// ── POST /users/relationships ─────────────────────────────────
router.post(
  '/relationships',
  [
    body('elder_id').isUUID(),
    body('relationship_type').isIn(['child', 'spouse', 'sibling', 'caregiver', 'other']),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    const rel = await Guardian.requestRelationship(
      req.user.id, req.body.elder_id, req.body.relationship_type
    );
    res.status(201).json({ data: rel });
  })
);

// ── PATCH /users/relationships/:id ───────────────────────────
router.patch(
  '/relationships/:id',
  [
    param('id').isUUID(),
    body('status').isIn(['accepted', 'rejected']),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    const rel = await Guardian.updateConsent(req.params.id, req.user.id, req.body.status);
    res.json({ data: rel });
  })
);

// ── DELETE /users/relationships/:id ──────────────────────────
router.delete(
  '/relationships/:id',
  [param('id').isUUID()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });

    // 관계 ID로 elder_id 조회 후 삭제
    await Guardian.removeRelationship(req.user.id, req.params.id);
    res.status(204).send();
  })
);

module.exports = router;
