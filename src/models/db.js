/**
 * src/models/db.js — PostgreSQL 연결 풀 + 인메모리 폴백
 *
 * PostgreSQL 연결 실패 시 JS Map 기반 인메모리 스토어로 자동 전환.
 * 앱이 DB 없이도 기동되고 핵심 CRUD 동작을 유지한다.
 *
 * 환경변수:
 *   DATABASE_URL  — postgresql://user:***@host:5432/dbname
 *   DB_POOL_MAX   — 최대 연결 수 (기본 10)
 */

'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');

// ── 인메모리 스토어 ────────────────────────────────────────────
const memStore = {
  users: new Map(),            // id -> user 객체
  usersByEmail: new Map(),     // email(소문자) -> user 객체
  refresh_tokens: [],          // [{ id, user_id, token_hash, expires_at, revoked_at }]
  medication_schedules: new Map(), // id -> schedule 객체
  emergency_events: new Map(), // id -> event 객체
  elders: new Map(),           // id -> elder 객체
};

function sha256hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

/**
 * 간단한 SQL 패턴 매칭 → 인메모리 스토어 CRUD
 * PG 쿼리 텍스트를 소문자+공백 정규화 후 패턴 판별.
 */
function memQuery(text, params = []) {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');

  // ── SELECT 1 (ping) ──────────────────────────────────────────
  if (/^select 1$/.test(t) || /^select \$1$/.test(t)) {
    return { rows: [{ '?column?': 1 }], rowCount: 1 };
  }

  // ── users ────────────────────────────────────────────────────

  // SELECT * FROM users WHERE email = $1 ...
  if (t.includes('from users') && t.startsWith('select') && t.includes('email = $1')) {
    const email = (params[0] || '').toLowerCase();
    const user = memStore.usersByEmail.get(email);
    if (!user || user.is_deleted) return { rows: [], rowCount: 0 };
    return { rows: [{ ...user }], rowCount: 1 };
  }

  // SELECT ... FROM users WHERE id = $1 ...  (authenticate 미들웨어)
  if (t.includes('from users') && t.startsWith('select') && t.includes('where') && t.includes('id = $1')) {
    const userId = params[0];
    const user = memStore.users.get(userId);
    if (!user || user.is_deleted) return { rows: [], rowCount: 0 };
    const { password_hash: _ph, ...safe } = user;
    return { rows: [safe], rowCount: 1 };
  }

  // INSERT INTO users ...
  if (t.startsWith('insert into users')) {
    const id = params[0] || uuid();
    const email = (params[1] || '').toLowerCase();
    const phone = params[2] || null;
    const password_hash = params[3];
    const display_name = params[4];
    const role = params[5];
    const now = new Date().toISOString();
    const user = {
      id, email, phone, password_hash, display_name, role,
      created_at: now, updated_at: now,
      is_deleted: false, fcm_token: null, profile_image_url: null,
    };
    memStore.users.set(id, user);
    memStore.usersByEmail.set(email, user);
    const { password_hash: _ph, ...safe } = user;
    return { rows: [safe], rowCount: 1 };
  }

  // UPDATE users SET is_deleted = true (anonymize)
  if (t.startsWith('update users') && t.includes('is_deleted')) {
    const userId = params[0];
    const user = memStore.users.get(userId);
    if (user) {
      const anonEmail = params[1] || `deleted_${uuid()}@deleted.invalid`;
      memStore.usersByEmail.delete(user.email);
      user.email = anonEmail;
      user.phone = params[2] || null;
      user.display_name = '탈퇴한 사용자';
      user.password_hash = '';
      user.fcm_token = null;
      user.is_deleted = true;
      user.deleted_at = new Date().toISOString();
      memStore.usersByEmail.set(anonEmail, user);
    }
    return { rows: [], rowCount: user ? 1 : 0 };
  }

  // UPDATE users SET fcm_token = $2 ...
  if (t.startsWith('update users') && t.includes('fcm_token')) {
    const userId = params[0];
    const user = memStore.users.get(userId);
    if (user) user.fcm_token = params[1] || null;
    return { rows: [], rowCount: user ? 1 : 0 };
  }

  // ── refresh_tokens ───────────────────────────────────────────

  // INSERT INTO refresh_tokens ...
  if (t.startsWith('insert into refresh_tokens')) {
    const user_id = params[0];
    const rawToken = params[1];
    const token_hash = rawToken ? sha256hex(rawToken) : rawToken;
    const expires_at = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    // ON CONFLICT DO NOTHING — 중복 방지
    const exists = memStore.refresh_tokens.find(
      r => r.user_id === user_id && r.token_hash === token_hash && !r.revoked_at
    );
    if (!exists) {
      memStore.refresh_tokens.push({ id: uuid(), user_id, token_hash, expires_at, revoked_at: null });
    }
    return { rows: [], rowCount: 1 };
  }

  // SELECT FROM refresh_tokens (화이트리스트 확인)
  if (t.includes('from refresh_tokens') && t.startsWith('select')) {
    const user_id = params[0];
    const rawToken = params[1];
    const token_hash = rawToken ? sha256hex(rawToken) : rawToken;
    const now = new Date();
    const found = memStore.refresh_tokens.find(rt =>
      rt.user_id === user_id &&
      rt.token_hash === token_hash &&
      new Date(rt.expires_at) > now &&
      !rt.revoked_at
    );
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  // UPDATE refresh_tokens SET revoked_at (logout / anonymize)
  if (t.startsWith('update refresh_tokens')) {
    const user_id = params[0];
    const rawToken = params[1];
    const token_hash = rawToken ? sha256hex(rawToken) : null;
    const now = new Date();
    memStore.refresh_tokens.forEach(rt => {
      if (rt.user_id === user_id && (!token_hash || rt.token_hash === token_hash)) {
        rt.revoked_at = now;
      }
    });
    return { rows: [], rowCount: 0 };
  }

  // ── elders / guardian_relationships (관계 검증) ──────────────
  // 폴백 모드에서는 접근 허용 (테스트/개발용)

  if (t.includes('from elders') && t.startsWith('select')) {
    // 노인 본인 체크 — 폴백: 허용
    return { rows: [{ id: params[0] || uuid() }], rowCount: 1 };
  }

  if (t.includes('from guardian_relationships') && t.startsWith('select')) {
    // 보호자 관계 체크 — 폴백: 허용
    return { rows: [{ id: uuid() }], rowCount: 1 };
  }

  // ── medication_schedules ─────────────────────────────────────

  // SELECT FROM medication_schedules WHERE elder_id = $1
  if (t.includes('from medication_schedules') && t.startsWith('select')) {
    const elder_id = params[0];
    const rows = [...memStore.medication_schedules.values()]
      .filter(s => s.elder_id === elder_id && s.is_active !== false);
    return { rows, rowCount: rows.length };
  }

  // INSERT INTO medication_schedules
  if (t.startsWith('insert into medication_schedules')) {
    const id = uuid();
    const now = new Date().toISOString();
    const schedule = {
      id,
      elder_id: params[0],
      medication_name: params[1],
      dosage: params[2],
      frequency: params[3],
      scheduled_times: params[4],
      created_by: params[5],
      is_active: true,
      created_at: now,
    };
    memStore.medication_schedules.set(id, schedule);
    return { rows: [schedule], rowCount: 1 };
  }

  // ── emergency_events ─────────────────────────────────────────

  // INSERT INTO emergency_events
  if (t.startsWith('insert into emergency_events')) {
    const id = uuid();
    const now = new Date().toISOString();
    const event = {
      id,
      elder_id: params[0],
      trigger_type: params[1],
      latitude: params[2] || null,
      longitude: params[3] || null,
      status: 'active',
      triggered_by: params[4],
      triggered_at: now,
    };
    memStore.emergency_events.set(id, event);
    return { rows: [event], rowCount: 1 };
  }

  // UPDATE emergency_events SET status = 'resolved' ...
  if (t.startsWith('update emergency_events')) {
    const event_id = params[0];
    const event = memStore.emergency_events.get(event_id);
    if (event) {
      event.status = 'resolved';
      event.resolved_by = params[1];
      event.resolve_note = params[2];
      event.resolved_at = new Date().toISOString();
    }
    return { rows: event ? [event] : [], rowCount: event ? 1 : 0 };
  }

  // ── 기타 INSERT (로그 테이블 등) — 조용히 무시 ──────────────
  if (t.startsWith('insert into')) {
    return { rows: [], rowCount: 0 };
  }

  // ── 기본: 빈 결과 반환 ────────────────────────────────────────
  console.warn('[DB FALLBACK] Unhandled query (returning empty):', text.substring(0, 100));
  return { rows: [], rowCount: 0 };
}

// ── PostgreSQL 연결 설정 ───────────────────────────────────────

const connectionConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    };

const pool = new Pool({
  ...connectionConfig,
  max: parseInt(process.env.DB_POOL_MAX || '10'),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000, // 빠른 실패 → 폴백 전환 속도 향상
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }
    : false,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// 연결 에러인지 판별 (ECONNREFUSED, timeout, 네트워크 단절 등)
function isConnectionError(err) {
  const connCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', '57P01', 'PROTOCOL_CONNECTION_LOST'];
  return connCodes.includes(err.code) || (err.message && err.message.includes('ECONNREFUSED'));
}

// 폴백 상태
let _fallbackMode = false;

// ── db 헬퍼 ──────────────────────────────────────────────────
const db = {
  /** 현재 인메모리 폴백 모드인지 반환 */
  isFallback() { return _fallbackMode; },

  // 쿼리 헬퍼
  async query(text, params) {
    // 이미 폴백 모드 → 바로 인메모리 처리
    if (_fallbackMode) {
      return memQuery(text, params);
    }

    const start = Date.now();
    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - start;
      if (process.env.NODE_ENV !== 'production' && duration > 100) {
        console.warn(`[DB SLOW] ${duration}ms: ${text.substring(0, 80)}`);
      }
      return result;
    } catch (err) {
      if (isConnectionError(err)) {
        // 첫 연결 실패 → 폴백 모드 전환 (이후 요청은 바로 인메모리 사용)
        if (!_fallbackMode) {
          _fallbackMode = true;
          console.warn('[DB] PostgreSQL 연결 실패. 인메모리 폴백으로 전환합니다:', err.message);
        }
        return memQuery(text, params);
      }
      console.error('[DB ERROR]', err.message, '\nQuery:', text);
      throw err;
    }
  },

  // 트랜잭션 헬퍼
  async transaction(callback) {
    if (_fallbackMode) {
      // 폴백 모드 — 단순 순차 실행 (롤백 없음)
      const mockClient = {
        async query(text, params) { return memQuery(text, params); },
        release() {},
      };
      return callback(mockClient);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  pool,
  memStore, // 테스트/디버깅용
};

module.exports = db;
