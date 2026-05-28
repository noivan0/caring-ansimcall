/**
 * src/services/notificationService.js — FCM 푸시 알림 서비스
 *
 * 기능:
 *   - notifyGuardians: 특정 노인의 보호자 전원에게 FCM 푸시
 *   - notifyUser: 특정 사용자에게 FCM 푸시
 *   - saveNotification: 알림 로그 DB 저장
 *
 * Firebase Admin SDK 초기화:
 *   FIREBASE_SERVICE_ACCOUNT_JSON 환경변수 (JSON 문자열) 또는
 *   FIREBASE_SERVICE_ACCOUNT_PATH (파일 경로)
 */

'use strict';

const admin  = require('firebase-admin');
const db     = require('../models/db');
const { Guardian } = require('../models/user');

// ── Firebase Admin 초기화 (싱글턴) ──────────────────────────
let firebaseApp;

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    credential = admin.credential.cert(require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
  } else {
    // 개발 환경 — 로컬 ADC (Application Default Credentials)
    credential = admin.credential.applicationDefault();
  }

  firebaseApp = admin.initializeApp({ credential });
  return firebaseApp;
}

// ── 핵심 FCM 발송 함수 ───────────────────────────────────────

/**
 * FCM 토큰 1개에 단건 발송
 * @param {string} fcmToken
 * @param {object} notification  — { title, body }
 * @param {object} [data]        — 앱에 전달할 추가 데이터 (key-value 문자열)
 * @param {boolean} [priority]   — true 면 'high' 우선순위
 * @returns {Promise<string|null>} messageId 또는 null
 */
async function sendFcmMessage(fcmToken, notification, data = {}, priority = false) {
  if (!fcmToken) return null;

  // FCM data 값은 반드시 문자열
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const message = {
    token: fcmToken,
    notification: {
      title: notification.title,
      body:  notification.body,
    },
    data: stringData,
    android: {
      priority: priority ? 'high' : 'normal',
      notification: { sound: priority ? 'emergency' : 'default' },
    },
    apns: {
      payload: {
        aps: {
          sound: priority ? 'emergency.caf' : 'default',
          badge: 1,
        },
      },
      headers: { 'apns-priority': priority ? '10' : '5' },
    },
  };

  try {
    const app = getFirebaseApp();
    const messageId = await admin.messaging(app).send(message);
    return messageId;
  } catch (err) {
    // 토큰 만료 — 조용히 처리 (향후 토큰 정리 배치)
    if (err.code === 'messaging/registration-token-not-registered') {
      console.warn(`[FCM] 만료된 토큰: ${fcmToken.substring(0, 20)}...`);
    } else {
      console.error('[FCM] 발송 실패:', err.code, err.message);
    }
    return null;
  }
}

// ── 알림 DB 로그 저장 ────────────────────────────────────────

/**
 * notifications 테이블에 알림 이력 저장
 * @param {string} userId
 * @param {string} type       — 'HEALTH_ALERT', 'SOS_TRIGGERED', 'MEDICATION_TAKEN' 등
 * @param {string} title
 * @param {string} body
 * @param {object} [data]
 */
async function saveNotification(userId, type, title, body, data = {}) {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, data, sent_at)
       VALUES ($1,$2,$3,$4,$5::jsonb, NOW())`,
      [userId, type, title, body, JSON.stringify(data)]
    );
  } catch (err) {
    console.error('[Notification] DB 저장 실패:', err.message);
  }
}

// ── 공개 API ─────────────────────────────────────────────────

/**
 * 특정 노인의 승인된 보호자 전원에게 FCM 푸시 발송
 *
 * @param {string} elderId      — elders.id (UUID)
 * @param {object} payload      — { type, title?, body?, ...데이터 }
 * @param {object} [opts]
 * @param {boolean} [opts.highPriority=false] — SOS 등 긴급 알림
 */
async function notifyGuardians(elderId, payload, { highPriority = false } = {}) {
  const guardians = await Guardian.findGuardiansByElder(elderId);
  if (!guardians.length) return;

  // 기본 알림 제목/내용 생성
  const { title, body } = buildNotificationText(payload);

  const tasks = guardians.map(async (guardian) => {
    // FCM 발송
    await sendFcmMessage(guardian.fcm_token, { title, body }, payload, highPriority);
    // DB 로그
    await saveNotification(guardian.id, payload.type, title, body, payload);
  });

  await Promise.allSettled(tasks);
}

/**
 * 특정 사용자 1명에게 FCM 푸시 발송
 *
 * @param {object} user         — { id, fcm_token, ... }
 * @param {object} payload      — { type, title?, body?, ...데이터 }
 * @param {object} [opts]
 */
async function notifyUser(user, payload, { highPriority = false } = {}) {
  const { title, body } = buildNotificationText(payload);
  await sendFcmMessage(user.fcm_token, { title, body }, payload, highPriority);
  await saveNotification(user.id, payload.type, title, body, payload);
}

// ── 알림 텍스트 생성 헬퍼 ────────────────────────────────────

function buildNotificationText(payload) {
  switch (payload.type) {
    case 'SOS_TRIGGERED':
      return {
        title: '긴급 SOS 발생',
        body:  payload.location
          ? `위치: ${payload.location.latitude.toFixed(4)}, ${payload.location.longitude.toFixed(4)}`
          : '노인분이 SOS를 눌렀습니다.',
      };
    case 'HEALTH_ALERT':
      return {
        title: '건강 이상 감지',
        body:  payload.alerts?.map(a => `${a.type}: ${a.value}`).join(', ') || '건강 수치를 확인해주세요.',
      };
    case 'SAFE_ZONE_EXIT':
      return {
        title: '안전구역 이탈',
        body:  `${payload.zoneName || '안전구역'}에서 이탈했습니다.`,
      };
    case 'MEDICATION_TAKEN':
      return {
        title: '복약 완료',
        body:  '복약을 완료했습니다.',
      };
    case 'MEDICATION_MISSED':
      return {
        title: '복약 미확인',
        body:  `${payload.medicationName || '복약'} 확인이 되지 않습니다.`,
      };
    case 'MEDICATION_ESCALATION':
      return {
        title: '복약 3회 연속 미확인 — 응급 확인 필요',
        body:  `${payload.medicationName || '복약'} 3회 연속 확인 안 됨.`,
      };
    default:
      return {
        title: payload.title || '노부모케어 알림',
        body:  payload.body  || '',
      };
  }
}

module.exports = { notifyGuardians, notifyUser, saveNotification, sendFcmMessage };
