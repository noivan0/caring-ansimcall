/**
 * src/routes/ivr.js — IVR 복약 응답 처리 API
 *
 * POST /api/medication/ivr-response        — 내부 JSON API용 IVR 응답 처리
 * POST /api/medication/ivr/twiml           — Twilio 음성 통화용 TwiML 생성
 * POST /api/medication/ivr/twilio-response — Twilio Gather 결과 처리
 * POST /api/medication/ivr/status          — Twilio 상태 콜백 기록
 */

'use strict';

const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const { asyncHandler } = require('../middleware/asyncHandler');
const { processIvrCall } = require('../services/IvrService');
const { validateTwilioWebhook } = require('../middleware/twilioAuth');
const {
  buildAbsoluteUrl,
  buildMedicationReminderTwiml,
  buildMedicationResultTwiml,
  getPublicBaseUrlFromRequest,
  getTwilioVoiceConfig,
  logIvrRuntimeEvent,
} = require('../services/twilioVoiceService');

// ── [A09 FIX] IVR 구조화 로깅 ────────────────────────────────
// call_sid / parent_id / child_id / status 구조화 기록 (OWASP A09)
function logIvrEvent(level, event, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    service: 'ivr',
    ...data,
  };
  // PII 마스킹: userId 마지막 4자리만 노출
  if (entry.userId && entry.userId.length > 4) {
    entry.userId_masked = `****${entry.userId.slice(-4)}`;
    delete entry.userId;
  }
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

function sendXml(res, xml) {
  res.type('text/xml; charset=utf-8');
  res.send(xml);
}

function parseTwilioGather(req) {
  const digits = req.body?.Digits;
  const speechResult = req.body?.SpeechResult;
  return {
    dtmfDigit: digits !== undefined && digits !== null && String(digits).trim() !== ''
      ? String(digits).trim()
      : null,
    rawText: speechResult !== undefined && speechResult !== null && String(speechResult).trim() !== ''
      ? String(speechResult).trim()
      : null,
    callSid: req.body?.CallSid || null,
    callStatus: req.body?.CallStatus || null,
  };
}

async function handleIvrProcessing({ userId, medication, rawText, dtmfDigit, date, time, lang }) {
  const result = await processIvrCall({
    userId,
    medication,
    rawText: rawText || null,
    dtmfDigit: dtmfDigit || null,
    date,
    time,
    lang: lang || 'ko',
  });

  return result;
}

// ── [A01 FIX Sprint-9] 내부 IVR 서비스 토큰 인증 ─────────────
/**
 * validateInternalIvrToken — POST /api/medication/ivr-response 전용 미들웨어.
 *
 * 이 엔드포인트는 내부 서비스 전용(Twilio webhook이 아님)이므로
 * Twilio 서명 대신 공유 시크릿 토큰으로 인증한다.
 *
 * 환경변수:
 *   INTERNAL_IVR_TOKEN: 내부 서비스가 Authorization: Bearer <token>으로 전달
 *   NODE_ENV=test: 테스트 환경에서는 스킵 (단, SKIP_INTERNAL_IVR_AUTH=true 명시 필요)
 *
 * 미설정(프로덕션): 503 Service Unavailable — fail-closed
 * SKIP_INTERNAL_IVR_AUTH=true: 개발/테스트 전용 스킵
 */
function validateInternalIvrToken(req, res, next) {
  // 개발/테스트 환경 명시적 스킵
  if (process.env.SKIP_INTERNAL_IVR_AUTH === 'true') {
    return next();
  }

  const expectedToken = process.env.INTERNAL_IVR_TOKEN;
  if (!expectedToken) {
    // INTERNAL_IVR_TOKEN 미설정 → fail-closed (프로덕션 설정 오류)
    console.error('[IvrAuth] INTERNAL_IVR_TOKEN 미설정 — 내부 IVR 엔드포인트를 비활성화합니다. 프로덕션 배포 전 설정 필수.');
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: '내부 IVR 서비스가 올바르게 설정되지 않았습니다.',
    });
  }

  const authHeader = req.headers['authorization'] || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!provided || provided !== expectedToken) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: '유효한 내부 서비스 토큰이 필요합니다.',
    });
  }

  next();
}

// ── POST /api/medication/ivr-response ────────────────────────
// 내부 JSON API용. 실제 Twilio webhook은 전용 /ivr/twilio-response 경로를 사용한다.
// [A01 FIX] validateInternalIvrToken으로 공개 비인증 접근 차단
router.post(
  '/ivr-response',
  validateInternalIvrToken,
  [
    body('userId').isString().notEmpty().withMessage('userId는 필수입니다.'),
    body('medication').isString().notEmpty().withMessage('medication은 필수입니다.'),
    body('rawText').optional({ nullable: true }).isString(),
    body('dtmfDigit').optional({ nullable: true }).isIn(['1', '2']).withMessage('DTMF는 1 또는 2이어야 합니다.'),
    body('date').optional().isISO8601().withMessage('날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)'),
    body('time').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/).withMessage('시간 형식이 올바르지 않습니다. (HH:MM)'),
    body('lang').optional().isIn(['ko', 'ja', 'en']).withMessage('지원 언어: ko, ja, en'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const { userId, medication, rawText, dtmfDigit, date, time, lang } = req.body;

    // [A09] IVR 요청 수신 구조화 로그
    logIvrEvent('info', 'ivr_request_received', {
      userId,
      medication,
      response_type: dtmfDigit ? 'DTMF' : (rawText ? 'STT' : 'NO_RESPONSE'),
      date, time, lang: lang || 'ko',
    });

    const result = await handleIvrProcessing({ userId, medication, rawText, dtmfDigit, date, time, lang });

    const responseBody = {
      data: {
        log: result.log,
        confirmed: result.parsed.confirmed,
        response_type: result.parsed.response_type,
        notified_family: result.notified_family,
        consecutive_missed: result.consecutive_missed,
      },
    };

    // 3일 연속 미복약 → 202 Accepted (가족 알림 발송됨)
    if (result.notified_family) {
      // [A09] 가족 알림 구조화 로그
      logIvrEvent('warn', 'consecutive_missed_escalation', {
        userId,
        medication,
        consecutive_missed: result.consecutive_missed,
        notified_family: true,
      });
      return res.status(202).json({
        ...responseBody,
        message: '3일 연속 미복약이 감지되어 가족에게 알림을 전송했습니다.',
      });
    }

    // [A09] 정상 IVR 처리 구조화 로그
    logIvrEvent('info', 'ivr_processed', {
      userId,
      medication,
      confirmed: result.parsed.confirmed,
      response_type: result.parsed.response_type,
    });

    res.status(201).json(responseBody);
  })
);

// ── POST /api/medication/ivr/twiml ───────────────────────────
router.post(
  '/ivr/twiml',
  validateTwilioWebhook,
  [
    query('userId').isString().notEmpty().withMessage('userId는 필수입니다.'),
    query('medication').isString().notEmpty().withMessage('medication은 필수입니다.'),
    query('lang').optional().isIn(['ko', 'ja', 'en']).withMessage('지원 언어: ko, ja, en'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const publicBaseUrl = getPublicBaseUrlFromRequest(req);
    const actionUrl = buildAbsoluteUrl(publicBaseUrl, '/api/medication/ivr/twilio-response', req.query);
    const xml = buildMedicationReminderTwiml({
      actionUrl,
      displayName: req.query.displayName,
      medication: req.query.medication,
      dosage: req.query.dosage,
      lang: req.query.lang || getTwilioVoiceConfig().defaultLang || 'ko',
    });

    logIvrRuntimeEvent('ivr_twiml_rendered', {
      user_id: req.query.userId,
      elder_id: req.query.elderId,
      schedule_id: req.query.scheduleId,
      medication: req.query.medication,
      call_sid: req.body?.CallSid || null,
    });

    sendXml(res, xml);
  })
);

// ── POST /api/medication/ivr/twilio-response ─────────────────
router.post(
  '/ivr/twilio-response',
  validateTwilioWebhook,
  [
    query('userId').isString().notEmpty().withMessage('userId는 필수입니다.'),
    query('medication').isString().notEmpty().withMessage('medication은 필수입니다.'),
    query('lang').optional().isIn(['ko', 'ja', 'en']).withMessage('지원 언어: ko, ja, en'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: errors.array() });
    }

    const { userId, elderId, scheduleId, medication } = req.query;
    const lang = req.query.lang || getTwilioVoiceConfig().defaultLang || 'ko';
    const { rawText, dtmfDigit, callSid, callStatus } = parseTwilioGather(req);

    logIvrEvent('info', 'twilio_gather_received', {
      userId,
      medication,
      call_sid: callSid,
      call_status: callStatus,
      response_type: dtmfDigit ? 'DTMF' : (rawText ? 'STT' : 'NO_RESPONSE'),
      lang,
    });

    const result = await handleIvrProcessing({
      userId,
      medication,
      rawText,
      dtmfDigit,
      lang,
    });

    logIvrRuntimeEvent('ivr_processed', {
      user_id: userId,
      elder_id: elderId || null,
      schedule_id: scheduleId || null,
      medication,
      call_sid: callSid,
      status: result.parsed.confirmed === null ? 'no_response' : 'completed',
      response_type: result.parsed.response_type,
      confirmed: result.parsed.confirmed,
      notified_family: result.notified_family,
    });

    const xml = buildMedicationResultTwiml({
      confirmed: result.parsed.confirmed,
      notifiedFamily: result.notified_family,
      lang,
    });

    sendXml(res, xml);
  })
);

// ── POST /api/medication/ivr/status ──────────────────────────
router.post(
  '/ivr/status',
  validateTwilioWebhook,
  asyncHandler(async (req, res) => {
    logIvrRuntimeEvent('ivr_call_status', {
      user_id: req.query.userId || null,
      elder_id: req.query.elderId || null,
      schedule_id: req.query.scheduleId || null,
      medication: req.query.medication || null,
      call_sid: req.body?.CallSid || null,
      call_status: req.body?.CallStatus || null,
      call_duration: req.body?.CallDuration || null,
      answered_by: req.body?.AnsweredBy || null,
    });

    res.status(204).end();
  })
);

/**
 * [MKT-H4] IVR 완료율 집계 — 부모님 응답률 NSM (목표: >70%)
 * GET /api/ivr/stats/weekly
 */
router.get('/stats/weekly', (req, res) => {
  try {
    const dbPath = process.env.IVR_LOGS_DB
      || process.env.IVR_CALL_LOG_DB_PATH
      || require('path').join(__dirname, '..', '..', 'data', 'ivr_call_logs.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = db.prepare(`
      SELECT COUNT(*) as total_sent,
        SUM(CASE WHEN json_extract(data, '$.status') = 'completed' THEN 1 ELSE 0 END) as completed
      FROM ivr_events WHERE event = 'ivr_processed' AND timestamp >= ?
    `).get(weekAgo) || { total_sent: 0, completed: 0 };
    db.close();
    const rate = row.total_sent > 0
      ? Math.round((row.completed / row.total_sent) * 100) : 0;
    const TARGET = 70; // 부모님 응답률 KPI
    res.json({
      period: 'weekly', sent: row.total_sent, completed: row.completed,
      response_rate_pct: rate, target_pct: TARGET, kpi_met: rate >= TARGET,
    });
  } catch (_) {
    res.json({ period: 'weekly', sent: 0, completed: 0,
      response_rate_pct: 0, target_pct: 70, kpi_met: false,
      note: '배포 후 실측 데이터 수집 시작' });
  }
});

module.exports = router;
