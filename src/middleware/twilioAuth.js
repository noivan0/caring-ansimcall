'use strict';
/**
 * src/middleware/twilioAuth.js
 * Twilio X-Twilio-Signature 검증 미들웨어
 *
 * [헤르2 HIGH 체크포인트] 외부 IVR 위조 방지
 * Twilio Webhook 요청 서명 검증 — 미검증 시 임의 POST로 IVR 데이터 위조 가능
 *
 * 참고: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */

const twilio = require('twilio');

/**
 * Twilio 서명 검증
 * Contract: Twilio 공식 Node helper `validateRequest(...)` 기준.
 * 이 경로의 `X-Twilio-Signature` 검증은 커스텀 HMAC-SHA256이 아니라
 * Twilio helper가 기대하는 서명 규약(현재 SDK 검증 경로 기준 SHA1)과 일치해야 한다.
 * @param {string} authToken - process.env.TWILIO_AUTH_TOKEN
 * @param {string} signature - X-Twilio-Signature 헤더값
 * @param {string} url - 전체 요청 URL (프로토콜 포함)
 * @param {object} params - POST body/query 파라미터
 * @returns {boolean}
 */
function validateTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature || !url) return false;
  return twilio.validateRequest(authToken, signature, url, params || {});
}

/**
 * Express 미들웨어 — Twilio Webhook 서명 검증
 * IVR 엔드포인트에 적용: router.post('/ivr-response', validateTwilioWebhook, handler)
 * 커스텀 해시 구현 대신 Twilio SDK validateRequest 계약을 단일 진실 원천으로 유지한다.
 *
 * 환경변수:
 *   TWILIO_AUTH_TOKEN: Twilio 계정의 Auth Token
 *   SKIP_TWILIO_VALIDATION: 'true' 시 개발환경 스킵 (테스트용)
 */
function validateTwilioWebhook(req, res, next) {
  // 개발/테스트 환경 스킵
  if (process.env.SKIP_TWILIO_VALIDATION === 'true') {
    return next();
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    // [A05 FIX Sprint-9] fail-closed: TWILIO_AUTH_TOKEN 미설정 → 503 (fail-open 제거)
    // 프로덕션에서 미설정 시 서비스를 비활성화하여 서명 우회 공격 차단.
    // 개발/테스트 환경은 SKIP_TWILIO_VALIDATION=true로 우회.
    console.error('[TwilioAuth] TWILIO_AUTH_TOKEN 미설정 — Twilio Webhook 엔드포인트를 비활성화합니다. 프로덕션 배포 전 필수 설정.');
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Twilio 서비스가 올바르게 설정되지 않았습니다.',
    });
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    return res.status(403).json({
      error: 'TWILIO_SIGNATURE_MISSING',
      message: 'X-Twilio-Signature 헤더가 없습니다.',
    });
  }

  // 전체 URL 구성
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['host'] || req.hostname;
  const url = `${proto}://${host}${req.originalUrl}`;

  const isValid = validateTwilioSignature(authToken, signature, url, req.body || {});

  if (!isValid) {
    console.error('[TwilioAuth] 서명 검증 실패 — 잠재적 위조 요청', {
      url,
      hasSignature: !!signature,
    });
    return res.status(403).json({
      error: 'TWILIO_SIGNATURE_INVALID',
      message: '유효하지 않은 Twilio 서명입니다.',
    });
  }

  next();
}

module.exports = { validateTwilioWebhook, validateTwilioSignature };
