/**
 * src/middleware/auth.js — JWT 인증 미들웨어
 *
 * authenticate  : Bearer 토큰 검증, req.user 주입
 * requireRole   : 역할(role) 기반 접근 제어 팩토리
 */

'use strict';

const jwt = require('jsonwebtoken');
const { User } = require('../models/user');
const db = require('../models/db');

// ── [A07 FIX] JWT 블랙리스트 — 로그아웃 시 토큰 무효화 ──────────────────
// 메모리 폴백: Redis 없을 때도 동작 (재시작 시 초기화됨 — 허용 가능)
const _revokedTokens = new Map(); // jti → expiry timestamp

function revokeToken(jti, expiry) {
  _revokedTokens.set(jti, expiry);
}

function isRevoked(jti) {
  const expiry = _revokedTokens.get(jti);
  if (!expiry) return false;
  if (Date.now() / 1000 > expiry) {
    _revokedTokens.delete(jti); // 만료된 토큰 자동 정리
    return false;
  }
  return true;
}

// Redis가 있으면 Redis 기반 블랙리스트 사용
async function revokeTokenRedis(jti, expiry) {
  try {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    await client.connect();
    const ttl = Math.max(1, expiry - Math.floor(Date.now() / 1000));
    await client.set(`caring:revoked:${jti}`, '1', { EX: ttl });
    await client.quit();
  } catch {
    // Redis 불가 → 메모리 폴백
    revokeToken(jti, expiry);
  }
}

async function isRevokedRedis(jti) {
  try {
    const { createClient } = require('redis');
    const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    await client.connect();
    const val = await client.get(`caring:revoked:${jti}`);
    await client.quit();
    return val !== null;
  } catch {
    return isRevoked(jti); // Redis 불가 → 메모리 폴백
  }
}

/**
 * Bearer JWT 검증 미들웨어
 * Authorization: Bearer ***
 */
async function authenticate(req, res, next) {
  const header = req.headers['authorization'] || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'MISSING_TOKEN', message: '인증 토큰이 필요합니다.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || process.env.SECRET_KEY, {
      issuer: 'senior-care',
    });

    if (payload.type !== 'access') {
      return res.status(401).json({ error: 'INVALID_TOKEN_TYPE' });
    }

    // [A07 FIX] JWT 블랙리스트 체크 — 로그아웃된 토큰 차단
    const jti = payload.jti || `${payload.sub}:${payload.iat}`;
    const revoked = await isRevokedRedis(jti);
    if (revoked) {
      return res.status(401).json({ error: 'TOKEN_REVOKED', message: '로그아웃된 토큰입니다.' });
    }

    // DB에서 최신 사용자 정보 조회 (탈퇴/잠금 반영)
    // 인메모리 폴백 모드이거나 DB 조회 실패 시 memStore에서 직접 조회
    let user = null;
    try {
      user = await User.findById(payload.sub);
    } catch (dbErr) {
      // DB 연결 불가 시 memStore에서 직접 조회 (EAI_AGAIN, ECONNREFUSED 등)
      const memUser = db.memStore.users.get(payload.sub);
      if (memUser && !memUser.is_deleted) {
        const { password_hash: _ph, ...safe } = memUser;
        user = safe;
      }
    }

    // 인메모리 폴백 모드일 때 memStore도 확인
    if (!user && db.isFallback()) {
      const memUser = db.memStore.users.get(payload.sub);
      if (memUser && !memUser.is_deleted) {
        const { password_hash: _ph, ...safe } = memUser;
        user = safe;
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'USER_NOT_FOUND' });
    }

    req.user = user;

    // [SC 2.2.1 WCAG] X-Token-Expires-In 헤더 — 클라이언트 세션 만료 경고에 사용
    // Access 토큰이 15분 → T-60초에 session:expiring Socket.IO 이벤트 발행
    if (payload.exp) {
      const secsLeft = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
      res.setHeader('X-Token-Expires-In', secsLeft);
      // 60초 이하 남은 경우 즉시 경고 헤더 추가 (AJAX 폴링 클라이언트 대응)
      if (secsLeft <= 60) {
        res.setHeader('X-Token-Expiring-Soon', '1');
      }
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'TOKEN_EXPIRED', message: '토큰이 만료되었습니다.' });
    }
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }
}

/**
 * 역할 기반 접근 제어 팩토리
 * @param {...string} roles — 허용할 역할 목록
 * @example router.delete('/admin', requireRole('admin', 'guardian'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'UNAUTHENTICATED' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `이 작업은 ${roles.join(', ')} 역할만 수행할 수 있습니다.`,
      });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, revokeTokenRedis, isRevokedRedis };
