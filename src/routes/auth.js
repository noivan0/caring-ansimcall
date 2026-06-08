/**
 * src/routes/auth.js — 인증 라우터
 *
 * POST /api/v1/auth/register    — 신규 가입
 * POST /api/v1/auth/login       — 로그인 → JWT 발급
 * POST /api/v1/auth/refresh     — Access 토큰 갱신
 * POST /api/v1/auth/logout      — 로그아웃 (refresh 토큰 무효화)
 * DELETE /api/v1/auth/account   — 회원 탈퇴 (개인정보보호법 — 익명화)
 */

'use strict';

const router   = require('express').Router();
const jwt      = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { asyncHandler } = require('../middleware/asyncHandler');
const { authenticate } = require('../middleware/auth');
const { User } = require('../models/user');
const db = require('../models/db');

// 로그인 레이트 리밋 — 무차별 대입 방지
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'TOO_MANY_ATTEMPTS', message: '잠시 후 다시 시도해 주세요.' },
});

// ── 토큰 헬퍼 ────────────────────────────────────────────────
function signAccess(userId) {
  return jwt.sign(
    { sub: userId, type: 'access' },
    process.env.JWT_SECRET || process.env.SECRET_KEY,
    { expiresIn: '15m', issuer: 'senior-care' }
  );
}

function signRefresh(userId) {
  return jwt.sign(
    { sub: userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.SECRET_KEY,
    { expiresIn: '30d', issuer: 'senior-care' }
  );
}

// ── POST /auth/register ──────────────────────────────────────
router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('phone').optional().matches(/^\+82[0-9]{9,10}$/),
    body('password').isLength({ min: 8 }).matches(/\d/, 'g'),
    body('display_name').isString().trim().isLength({ min: 1, max: 50 }),
    body('role').isIn(['elder', 'guardian']),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const { email, phone, password, display_name, role } = req.body;

    const existing = await User.findByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'EMAIL_TAKEN', message: '이미 사용 중인 이메일입니다.' });
    }

    const user = await User.create({ email, phone, password, display_name, role });

    const accessToken  = signAccess(user.id);
    const refreshToken = signRefresh(user.id);

    // Refresh 토큰 DB 저장 (화이트리스트 방식)
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, encode(digest($2,'sha256'),'hex'), NOW() + INTERVAL '30 days')`,
      [user.id, refreshToken]
    );

    res.status(201).json({ data: { user, accessToken, refreshToken } });
  })
);

// ── POST /auth/login ─────────────────────────────────────────
router.post(
  '/login',
  loginLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isString().notEmpty(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const { email, password } = req.body;
    const user = await User.findByEmail(email);

    if (!user || !(await User.verifyPassword(password, user.password_hash))) {
      // 타이밍 공격 방지 — 항상 같은 형태의 응답
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '이메일 또는 비밀번호가 잘못되었습니다.' });
    }

    const accessToken  = signAccess(user.id);
    const refreshToken = signRefresh(user.id);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, encode(digest($2,'sha256'),'hex'), NOW() + INTERVAL '30 days')
       ON CONFLICT DO NOTHING`,
      [user.id, refreshToken]
    );

    const { password_hash: _ph, ...safeUser } = user;
    res.json({ data: { user: safeUser, accessToken, refreshToken } });
  })
);

// ── POST /auth/refresh ───────────────────────────────────────
router.post(
  '/refresh',
  [body('refreshToken').isString().notEmpty()],
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    let payload;
    try {
      payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, {
        issuer: 'senior-care',
      });
    } catch {
      return res.status(401).json({ error: 'INVALID_TOKEN' });
    }

    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: 'INVALID_TOKEN_TYPE' });
    }

    // DB 화이트리스트 확인
    const tokenRow = await db.query(
      `SELECT id FROM refresh_tokens
       WHERE user_id = $1
         AND token_hash = encode(digest($2,'sha256'),'hex')
         AND expires_at > NOW()
         AND revoked_at IS NULL`,
      [payload.sub, refreshToken]
    );

    if (!tokenRow.rows.length) {
      return res.status(401).json({ error: 'TOKEN_REVOKED' });
    }

    const newAccess = signAccess(payload.sub);
    res.json({ data: { accessToken: newAccess } });
  })
);

// ── GET /auth/me — 현재 인증 사용자 프로필 조회 ───────────────
// [Sprint-4 P1] localStorage.caring_user 백엔드 세션 검증 지원 엔드포인트
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND', message: '사용자를 찾을 수 없습니다.' });
  res.json({
    data: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      phone: user.phone || null,
      created_at: user.created_at,
    },
  });
}));

// ── POST /auth/logout ────────────────────────────────────────
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND token_hash = encode(digest($2,'sha256'),'hex')`,
      [req.user.id, refreshToken]
    );
  }
  res.status(204).send();
}));

// ── DELETE /auth/account ─────────────────────────────────────
// 개인정보보호법 제36조 — 정보주체 삭제 요청권
router.delete('/account', authenticate, asyncHandler(async (req, res) => {
  // 모든 refresh 토큰 무효화
  await db.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [req.user.id]);
  // 개인 식별 정보 익명화 (실제 레코드 삭제 X — 감사 로그 보존)
  await User.anonymize(req.user.id);
  res.status(204).send();
}));

module.exports = router;
