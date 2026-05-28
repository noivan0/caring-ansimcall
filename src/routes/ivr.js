/**
 * src/routes/ivr.js — IVR 복약 응답 처리 API
 *
 * POST /api/medication/ivr-response  — IVR 통화 결과 수신 및 처리
 */

'use strict';

const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { asyncHandler } = require('../middleware/asyncHandler');
const { processIvrCall } = require('../services/IvrService');

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

// ── POST /api/medication/ivr-response ────────────────────────
router.post(
  '/ivr-response',
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

    const result = await processIvrCall({
      userId,
      medication,
      rawText:   rawText   || null,
      dtmfDigit: dtmfDigit || null,
      date,
      time,
      lang:      lang      || 'ko',
    });

    const responseBody = {
      data: {
        log:                result.log,
        confirmed:          result.parsed.confirmed,
        response_type:      result.parsed.response_type,
        notified_family:    result.notified_family,
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


/**
 * [MKT-H4] IVR 완료율 집계 — 부모님 응답률 NSM (목표: >70%)
 * GET /api/ivr/stats/weekly
 */
router.get('/stats/weekly', (req, res) => {
  try {
    const dbPath = process.env.IVR_LOGS_DB
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
