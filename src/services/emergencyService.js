/**
 * src/services/emergencyService.js — 119 연동 서비스
 *
 * 소방청 e-안전신고 공공 API (공공데이터포털) 연동
 * API 키 미설정 시 → 노인 FCM 토큰으로 직접 전화 fallback
 *
 * 환경변수:
 *   EMERGENCY_119_API_KEY   — 공공데이터포털 API 키
 *   EMERGENCY_119_API_URL   — API 기본 URL (기본값 제공)
 */

'use strict';

const axios = require('axios');
const db    = require('../models/db');
const { Elder } = require('../models/user');

const API_119_BASE = process.env.EMERGENCY_119_API_URL
  || 'https://www.safetydata.go.kr/V2/api/DSSP-IF-00022';

const API_KEY = process.env.EMERGENCY_119_API_KEY;

/**
 * 119 신고 API 연동
 *
 * @param {object} params
 * @param {string} params.elderId   — elders.id
 * @param {string} params.eventId   — emergency_events.id
 * @param {number} [params.latitude]
 * @param {number} [params.longitude]
 * @returns {Promise<object>}        — { success, messageId?, reason? }
 */
async function trigger119({ elderId, eventId, latitude, longitude }) {
  if (!API_KEY) {
    console.warn('[119] API 키 미설정 — 직접 전화 fallback으로 처리됩니다.');
    return { success: false, reason: 'NO_API_KEY' };
  }

  // 노인 정보 조회
  const elder = await Elder.findById(elderId);
  if (!elder) {
    return { success: false, reason: 'ELDER_NOT_FOUND' };
  }

  // 119 신고 페이로드 구성
  const reportPayload = {
    serviceKey: API_KEY,
    rptPhn: elder.phone,         // 신고자 전화번호
    rptNm: elder.display_name,   // 신고자 이름
    rptCntnt: '노부모케어 앱 응급 SOS 자동 신고',
    wgs84Lat: latitude  ? String(latitude)  : null,
    wgs84Lon: longitude ? String(longitude) : null,
    rptTyNm: '응급환자',
    sttsCd: '001',  // 초기 접수
  };

  try {
    const response = await axios.post(API_119_BASE, reportPayload, {
      timeout: 8_000,
      headers: { 'Content-Type': 'application/json' },
    });

    const data = response.data;

    // API 응답 로그
    await db.query(
      `UPDATE emergency_events
       SET emergency_119_ref = $2, updated_at = NOW()
       WHERE id = $1`,
      [eventId, data.msgId || null]
    );

    console.log(`[119] 신고 완료 — eventId: ${eventId}, ref: ${data.msgId}`);
    return { success: true, messageId: data.msgId };
  } catch (err) {
    console.error('[119] 신고 실패:', err.message);

    // 실패 로그 기록
    await db.query(
      `UPDATE emergency_events
       SET emergency_119_ref = 'ERROR', updated_at = NOW()
       WHERE id = $1`,
      [eventId]
    );

    return { success: false, reason: err.message };
  }
}

/**
 * 응급 이벤트 에스컬레이션
 * 보호자가 X분 내 확인하지 않으면 호출
 *
 * @param {string} eventId
 * @param {number} minutesElapsed
 */
async function escalateEmergency(eventId, minutesElapsed) {
  try {
    const result = await db.query(
      `SELECT ee.*, e.display_name AS elder_name
       FROM emergency_events ee
       JOIN elders e ON e.id = ee.elder_id
       WHERE ee.id = $1 AND ee.status = 'active'`,
      [eventId]
    );

    if (!result.rows.length) return; // 이미 해제됨

    const event = result.rows[0];
    console.warn(`[응급 에스컬레이션] eventId: ${eventId}, ${minutesElapsed}분 미해제 — 재알림`);

    // 재알림은 notificationService에 위임
    return { event, escalated: true };
  } catch (err) {
    // [R44 NOVA-QA] IVR KPI 오염 방지 — 에러 무시하지 않고 로그+재throw
    console.error(`[escalateEmergency] DB 오류 eventId=${eventId}:`, err.message);
    throw err;
  }
}

module.exports = { trigger119, escalateEmergency };
