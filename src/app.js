/**
 * src/app.js — 노부모케어 Express 엔트리포인트
 *
 * 역할:
 *   - 미들웨어 설정 (CORS, 보안 헤더, 레이트 리밋, 로깅)
 *   - 라우터 등록
 *   - Socket.IO 초기화 (실시간 채팅 / 알림)
 *   - 서버 기동
 */

'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

// ── 라우터 ──────────────────────────────────────────────────
const healthRouter        = require('./routes/health');
const locationRouter      = require('./routes/location');
const authRouter          = require('./routes/auth');
const userRouter          = require('./routes/users');
const medRouter           = require('./routes/medications');
const emergencyRouter     = require('./routes/emergency');
const healthProfileRouter = require('./routes/healthProfile');
const ivrRouter           = require('./routes/ivr');

// ── 다국어 지원 ──────────────────────────────────────────────
const { i18nMiddleware } = require('./middleware/i18n');

// ── 복약 알림 스케줄러 ────────────────────────────────────────
const { startMedicationReminder } = require('./cron/medication_reminder');

// ── 앱 초기화 ────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Socket.IO ────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// Socket 이벤트 핸들러는 별도 모듈로 분리
require('./sockets/chatSocket')(io);
require('./sockets/alertSocket')(io);

// app에 io 인스턴스 바인딩 (라우터에서 접근 가능)
app.set('io', io);

// ── 미들웨어 ─────────────────────────────────────────────────

// 보안 헤더 (XSS, clickjacking, MIME sniffing 방지)
// helmet 대신 직접 미들웨어 설정 - script-src-attr 'none' 자동 추가 방지
app.use(helmet({
  contentSecurityPolicy: false,  // 직접 설정
}));
app.use(function(req, res, next) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self'"
  );
  next();
});

// CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 요청 파싱
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 로깅
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// 다국어 지원 미들웨어 (?lang 또는 Accept-Language 헤더)
app.use(i18nMiddleware());

// 전역 레이트 리밋 — 개인정보보호법 준수 (무차별 대입 방지)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15분
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS', message: '잠시 후 다시 시도해 주세요.' },
});
app.use(globalLimiter);

// ── 라우터 등록 ──────────────────────────────────────────────
const API = '/api/v1';

// 정적 파일 서빙 (웹 앱)
const path = require('path');
app.use('/static', express.static(path.join(__dirname, '..', 'public')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));



app.use(`${API}/health`,      healthRouter);
app.use(`${API}/auth`,        authRouter);
app.use(`${API}/users`,       userRouter);
app.use(`${API}/location`,    locationRouter);
app.use(`${API}/medications`, medRouter);
app.use(`${API}/emergency`,   emergencyRouter);

// ── 신규 라우터 ───────────────────────────────────────────────
// 건강 프로필 API (부모님 건강/질병 기본 정보)
app.use('/api/health-profile', healthProfileRouter);
// IVR 복약 응답 API
app.use('/api/medication', ivrRouter);

// ── 헬스체크 (로드밸런서 용) ─────────────────────────────────
app.get('/ping', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// 루트 → /app 리다이렉트 (포워더에서 / 접속 시 UI 서빙)
app.get('/', (_req, res) => res.redirect('/app'));

// ── GET /health/live — Liveness Probe ────────────────────────
// 프로세스가 살아있는지만 확인 (Kubernetes liveness probe)
// 의존성(DB/Redis) 불문하고 프로세스 자체가 실행 중이면 200
app.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'alive', ts: Date.now() });
});

// ── GET /health/ready — Readiness Probe ──────────────────────
// 트래픽을 받을 준비가 됐는지 확인 (Kubernetes readiness probe)
// DB + Redis 모두 정상이어야 200; 하나라도 오류면 503 반환
app.get('/health/ready', async (_req, res) => {
  const version = require('../package.json').version;
  const result = { status: 'ready', db: 'unknown', redis: 'unknown', version };
  let allOk = true;

  // DB 연결 확인
  try {
    const { pool } = require('./models/db');
    await pool.query('SELECT 1');
    result.db = 'ok';
  } catch {
    result.db = 'error';
    result.status = 'not_ready';
    allOk = false;
  }

  // Redis 연결 확인 — REDIS_URL 없으면 skip (Python FastAPI와 동일 동작)
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    result.redis = 'skipped';
  } else {
    try {
      const { createClient } = require('redis');
      const client = createClient({ url: redisUrl });
      await client.connect();
      await client.ping();
      await client.quit();
      result.redis = 'ok';
    } catch {
      result.redis = 'error';
      result.status = 'not_ready';
      allOk = false;
    }
  }

  // ready 상태이면 200, 의존성 오류 시 503 (로드밸런서가 트래픽 제외)
  res.status(allOk ? 200 : 503).json(result);
});

// ── GET /health — 상세 헬스체크 (DB + Redis + 버전) ──────────
app.get('/health', async (_req, res) => {
  const version = require('../package.json').version;
  const result = { status: 'ok', db: 'unknown', redis: 'unknown', version };

  // DB 연결 확인
  try {
    const { pool } = require('./models/db');
    await pool.query('SELECT 1');
    result.db = 'ok';
  } catch {
    result.db = 'error';
    result.status = 'degraded';
  }

  // Redis 연결 확인
  try {
    const { createClient } = require('redis');
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const client = createClient({ url: redisUrl });
    await client.connect();
    await client.ping();
    await client.quit();
    result.redis = 'ok';
  } catch {
    result.redis = 'error';
    result.status = 'degraded';
  }

  // 항상 200 반환 — 로드밸런서가 앱 프로세스 생존 여부만 확인
  // DB/Redis 상태는 result 내 'db', 'redis' 필드로 구분
  res.status(200).json(result);
});

// ── 404 처리 ─────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: '요청한 리소스가 없습니다.' });
});

// ── 전역 에러 핸들러 ─────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;

  // 운영 환경에서는 스택 숨기기
  const body = {
    error: err.code || 'INTERNAL_ERROR',
    message: status < 500 ? err.message : '서버 오류가 발생했습니다.',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  };

  if (status >= 500) {
    console.error('[ERROR]', err);
  }

  res.status(status).json(body);
});

// ── 기동 ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

// 직접 실행 시에만 listen (테스트 환경에서 EADDRINUSE 방지)
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`노부모케어 API 서버 기동 — port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    // 복약 알림 스케줄러 시작
    startMedicationReminder();
  });
}

module.exports = { app, server, io }; // 테스트용 export
