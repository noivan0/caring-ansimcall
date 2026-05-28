'use strict';
/**
 * src/middleware/twilioAuth.js
 * Twilio X-Twilio-Signature HMAC-SHA256 검증 미들웨어
 *
 * [헤르2 HIGH 체크포인트] 외부 IVR 위조 방지
 * Twilio Webhook 요청 서명 검증 — 미검증 시 임의 POST로 IVR 데이터 위조 가능
 *
 * 참고: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */

const crypto = require('crypto');

/**
 * Twilio 서명 검증
 * @param {string} authToken - process.env.TWILIO_AUTH_TOKEN
 * @param {string} signature - X-Twilio-Signature 헤더값
 * @param {string} url - 전체 요청 URL (프로토콜 포함)
 * @param {object} params - POST body 파라미터
 * @returns {boolean}
 */
function validateTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature || !url) return false;

  // Twilio 서명 생성 방법:
  // 1. URL + 정렬된 파라미터 문자열 구성
  // 2. HMAC-SHA256 with authToken
  // 3. Base64 encode

  let str = url;

  if (params && typeof params === 'object' && Object.keys(params).length > 0) {
    const sortedKeys = Object.keys(params).sort();
    for (const key of sortedKeys) {
      str += key + params[key];
    }
  }

  const computed = crypto
    .createHmac('sha256', authToken)
    .update(Buffer.from(str, 'utf-8'))
    .digest('base64');

  // timing-safe 비교
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

/**
 * Express 미들웨어 — Twilio Webhook 서명 검증
 * IVR 엔드포인트에 적용: router.post('/ivr-response', validateTwilioWebhook, handler)
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
    // authToken 미설정 시 경고 후 통과 (운영 배포 전 필수 설정)
    console.warn('[TwilioAuth] TWILIO_AUTH_TOKEN 미설정 — 프로덕션 배포 전 필수');
    return next();
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
