/**
 * src/routes/healthProfile.js — 부모님 건강/질병 기본정보 CRUD API
 *
 * GET  /api/health-profile/:userId  — 건강 프로필 조회
 * POST /api/health-profile/:userId  — 건강 프로필 생성
 * PUT  /api/health-profile/:userId  — 건강 프로필 수정
 */

'use strict';

const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { HealthProfile } = require('../models/HealthProfile');

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

// 인증 필수
router.use(authenticate);

// ── 공통 validation ───────────────────────────────────────────
const profileValidators = [
  body('name').optional().isString().trim().isLength({ min: 1, max: 100 }),
  body('age').optional().isInt({ min: 0, max: 150 }),
  body('conditions').optional().isArray(),
  body('conditions.*').optional().isString(),
  body('medications').optional().isArray(),
  body('medications.*').optional().isString(),
  body('allergies').optional().isArray(),
  body('allergies.*').optional().isString(),
  body('doctorName').optional().isString().trim().isLength({ max: 100 }),
  body('doctorPhone').optional().isString().trim().isLength({ max: 30 }),
  body('bloodType').optional().isIn(BLOOD_TYPES),
  body('emergencyContact').optional().isObject(),
  body('emergencyContact.name').optional().isString(),
  body('emergencyContact.phone').optional().isString(),
  body('emergencyContact.relation').optional().isString(),
];

// ── GET /api/health-profile/:userId ──────────────────────────
router.get(
  '/:userId',
  [param('userId').isString().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const { userId } = req.params;

    // 본인 또는 보호자(guardian)만 접근 가능
    if (req.user.role === 'elder' && req.user.id !== userId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '본인 프로필만 조회할 수 있습니다.' });
    }

    const profile = HealthProfile.findByUserId(userId);
    if (!profile) {
      return res.status(404).json({ error: 'PROFILE_NOT_FOUND', message: '건강 프로필이 없습니다.' });
    }

    res.json({ data: profile });
  })
);

// ── POST /api/health-profile/:userId ─────────────────────────
router.post(
  '/:userId',
  [
    param('userId').isString().notEmpty(),
    ...profileValidators,
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const { userId } = req.params;

    // 본인 또는 보호자만 생성 가능
    if (req.user.role === 'elder' && req.user.id !== userId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '본인 프로필만 생성할 수 있습니다.' });
    }

    // 이미 존재하면 409
    const existing = HealthProfile.findByUserId(userId);
    if (existing) {
      return res.status(409).json({ error: 'PROFILE_EXISTS', message: '건강 프로필이 이미 존재합니다. PUT으로 수정하세요.' });
    }

    const profile = HealthProfile.create(userId, req.body);
    res.status(201).json({ data: profile });
  })
);

// ── PUT /api/health-profile/:userId ──────────────────────────
router.put(
  '/:userId',
  [
    param('userId').isString().notEmpty(),
    ...profileValidators,
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const { userId } = req.params;

    // 본인 또는 보호자만 수정 가능
    if (req.user.role === 'elder' && req.user.id !== userId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '본인 프로필만 수정할 수 있습니다.' });
    }

    const profile = HealthProfile.update(userId, req.body);
    res.json({ data: profile });
  })
);

module.exports = router;
