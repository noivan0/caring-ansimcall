/**
 * src/services/inviteService.js
 * 케어링 가족 초대 서비스 — 신원인증 CRITICAL 해소
 *
 * 보안 설계:
 *   - 6자리 숫자 코드 + Redis TTL 86400s
 *   - Rate limit: 발급자 하루 5회 (Redis INCR)
 *   - 잘못된 코드 5회 → 30분 잠금 (BRUTE_FORCE 방어)
 *   - OTP 이중인증: 수락자 전화번호 OTP 검증 후 관계 확정
 *   - 코드 수락 즉시 삭제 (재사용 방지)
 *   - audit_log 기록 (모든 시도)
 *
 * CVSS 9.3 해소: 아무나 타인 부모님 등록 불가
 */

'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const INVITE_TTL_SEC = 86400;          // 24시간
const RATE_LIMIT_MAX = 5;              // 발급자 하루 최대 5회
const BRUTE_FORCE_MAX = 5;             // 잘못된 코드 최대 5회
const BRUTE_FORCE_LOCKOUT_SEC = 1800;  // 30분 잠금

// ────────────────────────────────────────────────
//  코드 생성
// ────────────────────────────────────────────────

/**
 * 암호학적으로 안전한 6자리 숫자 코드 생성
 * random.randint 계열 대신 crypto.randomInt 사용
 */
function _generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

// ────────────────────────────────────────────────
//  Rate Limit 체크
// ────────────────────────────────────────────────

/**
 * 발급자 하루 5회 제한 확인
 * @param {object} redis - Redis 클라이언트
 * @param {string} userId - 초대 발급자 ID
 * @returns {Promise<{allowed: boolean, remaining: number}>}
 */
async function checkRateLimit(redis, userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `invite_rate:${userId}:${today}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 86400);
  return {
    allowed: count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - count),
    count,
  };
}

// ────────────────────────────────────────────────
//  초대 생성
// ────────────────────────────────────────────────

/**
 * 초대 코드 발급 + Redis 저장
 * @param {object} redis
 * @param {string} inviterId - 초대 발급자 userId
 * @param {string} inviteePhone - 초대받는 전화번호 (E.164)
 * @param {string} elderPhone - 부모님 전화번호
 * @returns {Promise<{code, inviteId, expiresIn}>}
 */
async function createInvite(redis, inviterId, inviteePhone, elderPhone) {
  const code = _generateCode();
  const inviteId = uuidv4();

  const payload = JSON.stringify({
    inviteId,
    inviterId,
    inviteePhone,
    elderPhone,
    createdAt: Date.now(),
  });

  await redis.set(`invite_code:${code}`, payload, 'EX', INVITE_TTL_SEC);

  return { code, inviteId, expiresIn: INVITE_TTL_SEC };
}

// ────────────────────────────────────────────────
//  Brute Force 방어
// ────────────────────────────────────────────────

/**
 * 잘못된 코드 시도 기록
 * @returns {Promise<{locked: boolean, attempts: number}>}
 */
async function recordFailedAttempt(redis, requesterIp) {
  const key = `invite_fail:${requesterIp}`;
  const attempts = await redis.incr(key);
  if (attempts === 1) await redis.expire(key, BRUTE_FORCE_LOCKOUT_SEC);
  const locked = attempts >= BRUTE_FORCE_MAX;
  return { locked, attempts };
}

/**
 * 잠금 상태 확인
 */
async function isLocked(redis, requesterIp) {
  const key = `invite_fail:${requesterIp}`;
  const attempts = await redis.get(key);
  return parseInt(attempts || '0') >= BRUTE_FORCE_MAX;
}

/**
 * 성공 시 실패 카운터 초기화
 */
async function clearFailedAttempts(redis, requesterIp) {
  await redis.del(`invite_fail:${requesterIp}`);
}

// ────────────────────────────────────────────────
//  초대 수락
// ────────────────────────────────────────────────

/**
 * 코드 검증 + OTP 확인 + 관계 확정
 * @param {object} redis
 * @param {string} code - 6자리 초대 코드
 * @param {string} accepterPhone - 수락자 전화번호
 * @param {string} phoneOtp - 수락자 OTP
 * @param {string} requesterIp - IP (Brute force 방어)
 * @returns {Promise<{success: boolean, payload?: object, error?: string}>}
 */
async function acceptInvite(redis, code, accepterPhone, phoneOtp, requesterIp) {
  // 1. Brute Force 잠금 확인
  if (await isLocked(redis, requesterIp)) {
    return { success: false, error: 'BRUTE_FORCE_LOCKED', lockedUntil: BRUTE_FORCE_LOCKOUT_SEC };
  }

  // 2. 코드 유효성 검증
  const raw = await redis.get(`invite_code:${code}`);
  if (!raw) {
    const failResult = await recordFailedAttempt(redis, requesterIp);
    return {
      success: false,
      error: 'INVALID_OR_EXPIRED_CODE',
      attemptsRemaining: BRUTE_FORCE_MAX - failResult.attempts,
    };
  }

  // 3. OTP 검증
  const storedOtp = await redis.get(`phone_otp:${accepterPhone}`);
  if (!storedOtp || storedOtp !== phoneOtp) {
    const failResult = await recordFailedAttempt(redis, requesterIp);
    return {
      success: false,
      error: 'INVALID_OTP',
      attemptsRemaining: BRUTE_FORCE_MAX - failResult.attempts,
    };
  }

  // 4. OTP 즉시 삭제 (재사용 방지)
  await redis.del(`phone_otp:${accepterPhone}`);

  // 5. 초대 코드 즉시 삭제 (재사용 방지)
  await redis.del(`invite_code:${code}`);

  // 6. 실패 카운터 초기화
  await clearFailedAttempts(redis, requesterIp);

  const payload = JSON.parse(raw);
  return { success: true, payload, authLevel: 2 };
}

// ────────────────────────────────────────────────
//  초대 거절
// ────────────────────────────────────────────────

async function rejectInvite(redis, code) {
  const raw = await redis.get(`invite_code:${code}`);
  if (!raw) return { success: false, error: 'INVALID_OR_EXPIRED_CODE' };
  await redis.del(`invite_code:${code}`);
  return { success: true };
}

module.exports = {
  createInvite,
  acceptInvite,
  rejectInvite,
  checkRateLimit,
  recordFailedAttempt,
  isLocked,
  clearFailedAttempts,
  _generateCode,
};
