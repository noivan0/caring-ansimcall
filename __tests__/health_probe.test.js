/**
 * Tests: Health probe endpoints
 *
 * GET /health/live  — Liveness probe (프로세스 생존 확인)
 * GET /health/ready — Readiness probe (DB + Redis 의존성 확인)
 *
 * 기존 setup.js에서 db mock 제공:
 *   db.pool = { end: jest.fn() }  ← pool.query 없음
 * 이 파일에서 pool.query를 별도로 mock해 준다.
 */
'use strict';

const request = require('supertest');
const db = require('../src/models/db');

// /health/ready 에서 `require('redis')` 를 동적으로 호출하므로 jest.mock 사용
jest.mock('redis', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    ping:    jest.fn().mockResolvedValue('PONG'),
    quit:    jest.fn().mockResolvedValue(undefined),
  };
  return { createClient: jest.fn().mockReturnValue(mockClient) };
});

// db.pool.query 주입 (setup.js에서 pool.end만 mock했으므로 query 추가)
beforeEach(() => {
  db.pool = db.pool || {};
  db.pool.query = jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
});

const { app } = require('../src/app');

// ── /health/canary ──────────────────────────────────────────
describe('GET /health/canary', () => {
  it('항상 200 ok 반환 (의존성 무관)', async () => {
    const res = await request(app).get('/health/canary');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.canary).toBe(true);
    expect(typeof res.body.ts).toBe('number');
  });

  it('DB 오류가 있어도 200 반환', async () => {
    db.pool.query = jest.fn().mockRejectedValue(new Error('DB 연결 실패'));
    const res = await request(app).get('/health/canary');
    expect(res.status).toBe(200);
    expect(res.body.canary).toBe(true);
  });
});

// ── /health/live ────────────────────────────────────────────
describe('GET /health/live', () => {
  it('항상 200 alive 반환 (DB/Redis 상태 무관)', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(typeof res.body.ts).toBe('number');
  });

  it('DB 오류가 있어도 200 반환', async () => {
    db.pool.query = jest.fn().mockRejectedValue(new Error('DB 연결 실패'));
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });
});

// ── /health/ready ───────────────────────────────────────────
describe('GET /health/ready', () => {
  it('DB + Redis 모두 정상이면 200 ready 반환', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.db).toBe('ok');
    expect(res.body.redis).toBe('ok');
  });

  it('REDIS_URL 없으면 redis=skipped, DB 정상이면 200 반환', async () => {
    const origRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.redis).toBe('skipped');

    // 환경변수 복원
    if (origRedisUrl !== undefined) process.env.REDIS_URL = origRedisUrl;
  });

  it('DB 오류 시 503 not_ready 반환', async () => {
    db.pool.query = jest.fn().mockRejectedValue(new Error('DB 연결 실패'));
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.db).toBe('error');
  });

  it('Redis 오류 시 503 not_ready 반환', async () => {
    // Redis 실패 mock
    const redis = require('redis');
    const failingClient = {
      connect: jest.fn().mockRejectedValue(new Error('Redis 연결 실패')),
      ping:    jest.fn(),
      quit:    jest.fn(),
    };
    redis.createClient.mockReturnValueOnce(failingClient);

    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.redis).toBe('error');
  });

  it('응답에 version 필드 포함', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.body.version).toBeDefined();
    expect(typeof res.body.version).toBe('string');
  });
});
