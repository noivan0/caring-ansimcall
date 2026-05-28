/**
 * __tests__/invite_service.test.js
 * InviteService 단위 테스트
 * CRITICAL CVSS 9.3 해소 검증
 */

'use strict';

const {
  createInvite,
  acceptInvite,
  rejectInvite,
  checkRateLimit,
  recordFailedAttempt,
  isLocked,
  clearFailedAttempts,
  _generateCode,
} = require('../src/services/inviteService');

// ── Mock Redis ──────────────────────────────────────────────
function createMockRedis(initialData = {}) {
  const store = { ...initialData };
  const expiries = {};

  return {
    async get(key) { return store[key] || null; },
    async set(key, val, ...args) {
      store[key] = val;
      // EX TTL 파싱
      const exIdx = args.indexOf('EX');
      if (exIdx !== -1) expiries[key] = args[exIdx + 1];
      return 'OK';
    },
    async incr(key) {
      store[key] = String(parseInt(store[key] || '0') + 1);
      return parseInt(store[key]);
    },
    async expire(key, ttl) { expiries[key] = ttl; return 1; },
    async del(...keys) { keys.flat().forEach(k => delete store[k]); return keys.flat().length; },
    _store: store,
    _expiries: expiries,
  };
}

// ────────────────────────────────────────────────────────────
//  _generateCode
// ────────────────────────────────────────────────────────────
describe('_generateCode', () => {
  test('6자리 숫자 코드 생성', () => {
    const code = _generateCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  test('100000 이상 999999 이하', () => {
    for (let i = 0; i < 50; i++) {
      const n = parseInt(_generateCode());
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });

  test('연속 2개는 달라야 함 (확률적)', () => {
    const codes = new Set(Array.from({ length: 20 }, () => _generateCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ────────────────────────────────────────────────────────────
//  checkRateLimit
// ────────────────────────────────────────────────────────────
describe('checkRateLimit', () => {
  test('첫 요청: allowed=true, count=1', async () => {
    const redis = createMockRedis();
    const result = await checkRateLimit(redis, 'user-1');
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });

  test('5회 이하: allowed=true', async () => {
    const redis = createMockRedis();
    for (let i = 0; i < 4; i++) await checkRateLimit(redis, 'user-1');
    const result = await checkRateLimit(redis, 'user-1');
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(5);
  });

  test('6회째: allowed=false', async () => {
    const redis = createMockRedis();
    for (let i = 0; i < 5; i++) await checkRateLimit(redis, 'user-1');
    const result = await checkRateLimit(redis, 'user-1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test('다른 userId는 독립 카운터', async () => {
    const redis = createMockRedis();
    for (let i = 0; i < 6; i++) await checkRateLimit(redis, 'user-A');
    const result = await checkRateLimit(redis, 'user-B');
    expect(result.allowed).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
//  createInvite
// ────────────────────────────────────────────────────────────
describe('createInvite', () => {
  test('코드 발급 성공', async () => {
    const redis = createMockRedis();
    const result = await createInvite(redis, 'inv-1', '+821011112222', '+821033334444');
    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.inviteId).toBeTruthy();
    expect(result.expiresIn).toBe(86400);
  });

  test('Redis에 코드 저장됨', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    const stored = await redis.get(`invite_code:${code}`);
    expect(stored).toBeTruthy();
    const payload = JSON.parse(stored);
    expect(payload.inviterId).toBe('inv-1');
  });

  test('payload에 inviteePhone, elderPhone 포함', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+821011112222', '+821099998888');
    const payload = JSON.parse(await redis.get(`invite_code:${code}`));
    expect(payload.inviteePhone).toBe('+821011112222');
    expect(payload.elderPhone).toBe('+821099998888');
  });

  test('TTL 86400 설정됨', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    expect(redis._expiries[`invite_code:${code}`]).toBe(86400);
  });
});

// ────────────────────────────────────────────────────────────
//  acceptInvite
// ────────────────────────────────────────────────────────────
describe('acceptInvite', () => {
  test('정상 수락 성공', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    // OTP 주입
    redis._store['phone_otp:+82101'] = '123456';
    const result = await acceptInvite(redis, code, '+82101', '123456', '127.0.0.1');
    expect(result.success).toBe(true);
    expect(result.authLevel).toBe(2);
    expect(result.payload.inviterId).toBe('inv-1');
  });

  test('수락 후 코드 삭제 (재사용 불가)', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    redis._store['phone_otp:+82101'] = '123456';
    await acceptInvite(redis, code, '+82101', '123456', '127.0.0.1');
    const stored = await redis.get(`invite_code:${code}`);
    expect(stored).toBeNull();
  });

  test('수락 후 OTP 삭제 (재사용 불가)', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    redis._store['phone_otp:+82101'] = '123456';
    await acceptInvite(redis, code, '+82101', '123456', '127.0.0.1');
    expect(await redis.get('phone_otp:+82101')).toBeNull();
  });

  test('잘못된 코드 → INVALID_OR_EXPIRED_CODE', async () => {
    const redis = createMockRedis();
    const result = await acceptInvite(redis, '000000', '+82101', '123456', '127.0.0.1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_OR_EXPIRED_CODE');
  });

  test('OTP 불일치 → INVALID_OTP', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    redis._store['phone_otp:+82101'] = '999999';
    const result = await acceptInvite(redis, code, '+82101', '123456', '127.0.0.1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_OTP');
  });

  test('OTP 없음 → INVALID_OTP', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    const result = await acceptInvite(redis, code, '+82101', '123456', '127.0.0.1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_OTP');
  });
});

// ────────────────────────────────────────────────────────────
//  Brute Force 방어
// ────────────────────────────────────────────────────────────
describe('Brute Force 방어', () => {
  test('5회 실패 → 잠금', async () => {
    const redis = createMockRedis();
    for (let i = 0; i < 5; i++) {
      await acceptInvite(redis, '000000', '+82101', '000000', '1.2.3.4');
    }
    const result = await acceptInvite(redis, '111111', '+82101', '111111', '1.2.3.4');
    expect(result.error).toBe('BRUTE_FORCE_LOCKED');
  });

  test('isLocked: 4회 실패 → false', async () => {
    const redis = createMockRedis();
    for (let i = 0; i < 4; i++) await recordFailedAttempt(redis, '1.2.3.4');
    expect(await isLocked(redis, '1.2.3.4')).toBe(false);
  });

  test('isLocked: 5회 실패 → true', async () => {
    const redis = createMockRedis();
    for (let i = 0; i < 5; i++) await recordFailedAttempt(redis, '1.2.3.4');
    expect(await isLocked(redis, '1.2.3.4')).toBe(true);
  });

  test('성공 시 실패 카운터 초기화', async () => {
    const redis = createMockRedis();
    for (let i = 0; i < 4; i++) await recordFailedAttempt(redis, '1.2.3.4');
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    redis._store['phone_otp:+82101'] = '123456';
    await acceptInvite(redis, code, '+82101', '123456', '1.2.3.4');
    expect(await isLocked(redis, '1.2.3.4')).toBe(false);
  });

  test('다른 IP는 독립 카운터', async () => {
    const redis = createMockRedis();
    for (let i = 0; i < 5; i++) await recordFailedAttempt(redis, '1.2.3.4');
    expect(await isLocked(redis, '5.6.7.8')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
//  rejectInvite
// ────────────────────────────────────────────────────────────
describe('rejectInvite', () => {
  test('존재하는 코드 거절 성공', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    const result = await rejectInvite(redis, code);
    expect(result.success).toBe(true);
  });

  test('거절 후 코드 삭제됨', async () => {
    const redis = createMockRedis();
    const { code } = await createInvite(redis, 'inv-1', '+82101', '+82102');
    await rejectInvite(redis, code);
    expect(await redis.get(`invite_code:${code}`)).toBeNull();
  });

  test('존재하지 않는 코드 거절 → error', async () => {
    const redis = createMockRedis();
    const result = await rejectInvite(redis, '999999');
    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_OR_EXPIRED_CODE');
  });
});
