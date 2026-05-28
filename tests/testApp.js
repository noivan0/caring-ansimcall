/**
 * tests/testApp.js — 테스트 전용 Express 앱
 *
 * 외부 의존성 (DB, Redis, Firebase, Socket.IO, node-cron) 모두 Mock으로
 * 대체한 경량 앱 인스턴스. supertest에서 이 파일을 임포트한다.
 *
 * Mock 전략:
 *   - db.query  : jest.fn() 반환 — 각 테스트에서 mockResolvedValue로 주입
 *   - firebase-admin : 초기화 없이 조용히 성공
 *   - node-cron     : 실제 스케줄 등록 없이 빈 객체
 *   - redis          : connect/ping/quit 전부 즉시 resolve
 */

'use strict';

// ── 최우선 Mock — require() 전에 등록 ──────────────────────────

// 1) DB pool mock
jest.mock('../src/models/db', () => {
  const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const mockConnect = jest.fn().mockResolvedValue({
    query: mockQuery,
    release: jest.fn(),
  });
  return {
    query: mockQuery,
    transaction: jest.fn(async (cb) => cb({ query: mockQuery, release: jest.fn() })),
    pool: {
      query: mockQuery,
      connect: mockConnect,
      on: jest.fn(),
    },
  };
});

// 2) firebase-admin mock
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(), applicationDefault: jest.fn() },
  messaging: jest.fn(() => ({
    send: jest.fn().mockResolvedValue('mock-message-id'),
  })),
}));

// 3) node-cron mock
jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

// 4) redis mock
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
}));

// 5) aws-sdk mock (aws-sdk removed from dependencies — mock kept for compat)
jest.mock('aws-sdk', () => ({
  S3: jest.fn(() => ({ upload: jest.fn() })),
}), { virtual: true });

// 6) emergencyService mock
jest.mock('../src/services/emergencyService', () => ({
  trigger119: jest.fn().mockResolvedValue({ success: false, reason: 'NO_API_KEY' }),
}));

// ── Express 앱 생성 ─────────────────────────────────────────

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const healthRouter   = require('../src/routes/health');
const locationRouter = require('../src/routes/location');
const authRouter     = require('../src/routes/auth');
const userRouter     = require('../src/routes/users');
const medRouter      = require('../src/routes/medications');
const emergencyRouter = require('../src/routes/emergency');

const app = express();

// 보안/파싱 미들웨어
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 레이트 리밋 (테스트에서는 넉넉하게)
const limiter = rateLimit({ windowMs: 60_000, max: 1000, legacyHeaders: false });
app.use(limiter);

// Socket.IO 더미 (emergency/location 라우터가 req.app.get('io') 를 사용)
const dummyIo = {
  to: jest.fn(() => ({ emit: jest.fn() })),
};
app.set('io', dummyIo);

// 라우터 등록
const API = '/api/v1';
app.use(`${API}/health`,      healthRouter);
app.use(`${API}/auth`,        authRouter);
app.use(`${API}/users`,       userRouter);
app.use(`${API}/location`,    locationRouter);
app.use(`${API}/medications`, medRouter);
app.use(`${API}/emergency`,   emergencyRouter);

// /ping
app.get('/ping', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// /health — DB+Redis 연결 체크 (mock)
app.get('/health', async (_req, res) => {
  const { version } = require('../package.json');
  const result = { status: 'ok', db: 'unknown', redis: 'unknown', version };

  try {
    const db = require('../src/models/db');
    await db.pool.query('SELECT 1');
    result.db = 'ok';
  } catch {
    result.db = 'error';
    result.status = 'degraded';
  }

  try {
    const { createClient } = require('redis');
    const client = createClient({ url: 'redis://localhost:6379' });
    await client.connect();
    await client.ping();
    await client.quit();
    result.redis = 'ok';
  } catch {
    result.redis = 'error';
    result.status = 'degraded';
  }

  const statusCode = result.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(result);
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: '요청한 리소스가 없습니다.' });
});

// 전역 에러 핸들러
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: err.code || 'INTERNAL_ERROR',
    message: status < 500 ? err.message : '서버 오류가 발생했습니다.',
  });
});

module.exports = app;
