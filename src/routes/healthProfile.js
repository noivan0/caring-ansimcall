/**
 * src/routes/healthProfile.js — 부모님 건강/질병 기본정보 CRUD API
 *
 * GET  /api/health-profile/:userId  — 건강 프로필 조회
 * POST /api/health-profile/:userId  — 건강 프로필 생성
 * PUT  /api/health-profile/:userId  — 건강 프로필 수정
 *
 * [A01 FIX Sprint-9] Guardian IDOR 수정:
 *   - elder: 본인만 접근 가능 (기존)
 *   - guardian: consent_status='accepted' 관계가 있는 노인만 접근 가능 (신규)
 */

'use strict';

const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { HealthProfile } = require('../models/HealthProfile');
const db = require('../models/db');

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

// 인증 필수
router.use(authenticate);

// ── [A01 FIX] 보호자-노인 관계 검증 헬퍼 ───────────────────────
/**
 * 보호자(guardianUserId)가 elderUserId와 수락된 관계인지 확인.
 * @param {string} guardianUserId
 * @param {string} elderUserId
 * @returns {Promise<boolean>}
 */
async function verifyGuardianRelationship(guardianUserId, elderUserId) {
  const result = await db.query(
    `SELECT id FROM guardian_relationships
     WHERE guardian_user_id = $1 AND elder_id = $2 AND consent_status = 'accepted'`,
    [guardianUserId, elderUserId]
  );
  return result.rowCount > 0;
}

/**
 * 공통 접근 제어 — healthProfile 라우트 전체에 적용.
 * - elder: 본인(:userId)만 허용
 * - guardian: 수락된 관계가 있는 :userId만 허용
 * @returns {Promise<boolean>} true = 접근 허용
 */
async function checkHealthProfileAccess(req, res, targetUserId) {
  const { role, id: requesterId } = req.user;

  if (role === 'elder') {
    if (requesterId !== targetUserId) {
      res.status(403).json({ error: 'FORBIDDEN', message: '본인 프로필만 접근할 수 있습니다.' });
      return false;
    }
    return true;
  }

  if (role === 'guardian') {
    // guardian 본인 프로필은 항상 허용
    if (requesterId === targetUserId) {
      return true;
    }
    // [A01 FIX] 수락된 관계 검증 — 임의 userId 접근 차단
    const hasRelation = await verifyGuardianRelationship(requesterId, targetUserId);
    if (!hasRelation) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: '관계가 확인된 노인의 프로필만 접근할 수 있습니다.',
      });
      return false;
    }
    return true;
  }

  // 알 수 없는 역할 — 차단
  res.status(403).json({ error: 'FORBIDDEN', message: '접근 권한이 없습니다.' });
  return false;
}

// ── 공통 validation ───────────────────────────────────────────────
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

// ── GET /api/health-profile/:userId ──────────────────────────────
router.get(
  '/:userId',
  [param('userId').isString().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const { userId } = req.params;

    // [A01 FIX] 접근 제어 — elder 본인 또는 관계 확인된 guardian
    const allowed = await checkHealthProfileAccess(req, res, userId);
    if (!allowed) return;

    const profile = HealthProfile.findByUserId(userId);
    if (!profile) {
      return res.status(404).json({ error: 'PROFILE_NOT_FOUND', message: '건강 프로필이 없습니다.' });
    }

    res.json({ data: profile });
  })
);

// ── POST /api/health-profile/:userId ─────────────────────────────
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

    // [A01 FIX] 접근 제어 — elder 본인 또는 관계 확인된 guardian
    const allowed = await checkHealthProfileAccess(req, res, userId);
    if (!allowed) return;

    // 이미 존재하면 409
    const existing = HealthProfile.findByUserId(userId);
    if (existing) {
      return res.status(409).json({ error: 'PROFILE_EXISTS', message: '건강 프로필이 이미 존재합니다. PUT으로 수정하세요.' });
    }

    const profile = HealthProfile.create(userId, req.body);
    res.status(201).json({ data: profile });
  })
);

// ── PUT /api/health-profile/:userId ──────────────────────────────
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

    // [A01 FIX] 접근 제어 — elder 본인 또는 관계 확인된 guardian
    const allowed = await checkHealthProfileAccess(req, res, userId);
    if (!allowed) return;

    const profile = HealthProfile.update(userId, req.body);
    res.json({ data: profile });
  })
);

module.exports = router;
