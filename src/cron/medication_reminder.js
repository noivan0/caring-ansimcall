/**
 * src/cron/medication_reminder.js — 복약 알림 스케줄러
 *
 * 기능:
 *   1. 매 분(cron '* * * * *') 실행 — 이 시간에 복약해야 하는 스케줄 탐색
 *   2. 노인에게 복약 알림 FCM 발송
 *   3. 30분 후 미확인 시 보호자 알림 (1차 escalation)
 *   4. 3회 연속 미확인 시 응급 에스컬레이션 알림 (2차 escalation)
 *
 * 환경변수:
 *   MED_CHECK_INTERVAL_MINUTES — 복약 미확인 후 보호자 알림까지 대기 시간 (기본 30)
 *   MED_ESCALATION_COUNT       — 연속 미확인 횟수 임계값 (기본 3)
 *
 * 서버 시작 시 호출:
 *   const { startMedicationReminder } = require('./cron/medication_reminder');
 *   startMedicationReminder();
 */

'use strict';

const cron = require('node-cron');
const db   = require('../models/db');
const { notifyGuardians, notifyUser, sendFcmMessage } = require('../services/notificationService');
const { Elder } = require('../models/Elder');
const { createMedicationReminderCall, isTwilioVoiceEnabled } = require('../services/twilioVoiceService');

const CHECK_INTERVAL_MINUTES = parseInt(process.env.MED_CHECK_INTERVAL_MINUTES || '30');
const ESCALATION_COUNT       = parseInt(process.env.MED_ESCALATION_COUNT       || '3');

// ── 복약 알림 발송 (매 분 실행) ──────────────────────────────

// [헤르2 HIGH-7 수정] Quiet Hours: 22:00~08:00 IVR 발신 차단 (부모님 수면 보호)
// KST 기준 UTC+9
const QUIET_HOURS_START = parseInt(process.env.QUIET_HOURS_START || '22'); // 22:00
const QUIET_HOURS_END   = parseInt(process.env.QUIET_HOURS_END   || '8');  // 08:00

function isQuietHours() {
  const kstHour = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
  return kstHour >= QUIET_HOURS_START || kstHour < QUIET_HOURS_END;
}

async function sendDueReminders() {
  // [Quiet Hours] 22:00~08:00 KST는 IVR 발신 완전 차단
  if (isQuietHours()) {
    return; // 부모님 수면 보호 — 알림 피로 방지
  }

  // DB 없으면 조용히 skip
  if (db.isFallback && db.isFallback()) {
    return;
  }

  const now       = new Date();
  const hh        = String(now.getHours()).padStart(2, '0');
  const mm        = String(now.getMinutes()).padStart(2, '0');
  const timeSlot  = `${hh}:${mm}`;              // "08:00" 형식
  const dayOfWeek = now.getDay() || 7;           // 1=월, 7=일 (JS 0=일 → 7로 변환)
  const twilioVoiceEnabled = isTwilioVoiceEnabled();

  // scheduled_times 배열에 현재 시각이 포함되고,
  // repeat_days 배열에 오늘 요일이 포함된 활성 스케줄 탐색
  const schedules = await db.query(
    `SELECT
       ms.id AS schedule_id,
       ms.elder_id,
       ms.medication_name,
       ms.dosage,
       e.user_id AS elder_user_id,
       u.phone AS elder_phone,
       u.fcm_token AS elder_fcm_token,
       u.display_name AS elder_name
     FROM medication_schedules ms
     JOIN elders e ON e.id = ms.elder_id
     JOIN users  u ON u.id = e.user_id
     WHERE ms.is_active = true
       AND $1 = ANY(ms.scheduled_times)
       AND $2 = ANY(ms.repeat_days)`,
    [timeSlot, dayOfWeek]
  );

  if (!schedules.rows.length) return;

  for (const sch of schedules.rows) {
    // 오늘 이미 복약 완료했는지 확인
    const alreadyTaken = await db.query(
      `SELECT 1 FROM medication_logs
       WHERE schedule_id = $1
         AND elder_id    = $2
         AND taken_at::date = CURRENT_DATE`,
      [sch.schedule_id, sch.elder_id]
    );

    if (alreadyTaken.rows.length) continue; // 이미 복약함

    if (twilioVoiceEnabled) {
      try {
        await createMedicationReminderCall({
          to: sch.elder_phone,
          userId: sch.elder_user_id,
          elderId: sch.elder_id,
          scheduleId: sch.schedule_id,
          medication: sch.medication_name,
          dosage: sch.dosage,
          displayName: sch.elder_name,
        });
      } catch (err) {
        console.error('[복약 IVR] Twilio 발신 실패:', err.message);
      }
    }

    // 노인에게 복약 알림 발송
    await sendFcmMessage(
      sch.elder_fcm_token,
      {
        title: '복약 시간입니다',
        body:  `${sch.medication_name} ${sch.dosage} — 복약 후 앱에서 확인 버튼을 눌러주세요.`,
      },
      {
        type:        'MEDICATION_REMINDER',
        scheduleId:  sch.schedule_id,
        medicationName: sch.medication_name,
      }
    );

    // 알림 발송 기록 저장 (미확인 추적용)
    await db.query(
      `INSERT INTO medication_reminder_log
         (schedule_id, elder_id, reminded_at, status)
       VALUES ($1,$2,NOW(),'pending')
       ON CONFLICT (schedule_id, elder_id, reminded_at::date) DO NOTHING`,
      [sch.schedule_id, sch.elder_id]
    ).catch(() => null); // 테이블 없으면 조용히 skip
  }
}

// ── 미확인 복약 보호자 에스컬레이션 ─────────────────────────

async function checkMissedMedications() {
  // DB 없으면 조용히 skip
  if (db.isFallback && db.isFallback()) {
    return;
  }

  const cutoff = new Date(Date.now() - CHECK_INTERVAL_MINUTES * 60_000);

  // CHECK_INTERVAL_MINUTES 분 전에 알림 보냈는데 아직 복약 기록 없는 스케줄
  const missed = await db.query(
    `SELECT
       ms.id        AS schedule_id,
       ms.elder_id,
       ms.medication_name,
       ms.dosage,
       COUNT(ml.id) AS taken_today
     FROM medication_schedules ms
     LEFT JOIN medication_logs ml
       ON ml.schedule_id = ms.id
       AND ml.elder_id   = ms.elder_id
       AND ml.taken_at::date = CURRENT_DATE
     WHERE ms.is_active = true
       AND (ms.reminded_at IS NULL OR ms.reminded_at < $1)
     GROUP BY ms.id, ms.elder_id, ms.medication_name, ms.dosage
     HAVING COUNT(ml.id) = 0`,
    [cutoff]
  ).catch(() => ({ rows: [] }));

  for (const sch of missed.rows) {
    // 연속 미확인 횟수 계산
    const missedCount = await db.query(
      `SELECT COUNT(*) AS cnt FROM medication_logs
       WHERE schedule_id = $1 AND elder_id = $2
         AND status = 'missed'
         AND taken_at > NOW() - INTERVAL '7 days'`,
      [sch.schedule_id, sch.elder_id]
    );

    const consecutiveMissed = parseInt(missedCount.rows[0]?.cnt || '0');

    if (consecutiveMissed >= ESCALATION_COUNT) {
      // 2차 에스컬레이션 — 응급 수준 알림
      await notifyGuardians(sch.elder_id, {
        type:           'MEDICATION_ESCALATION',
        medicationName: sch.medication_name,
        missedCount:    consecutiveMissed,
        scheduleId:     sch.schedule_id,
      }, { highPriority: true });

      console.warn(`[복약 에스컬레이션] ${sch.medication_name} — ${consecutiveMissed}회 연속 미확인`);
    } else {
      // 1차 — 보호자 일반 알림
      await notifyGuardians(sch.elder_id, {
        type:           'MEDICATION_MISSED',
        medicationName: sch.medication_name,
        scheduleId:     sch.schedule_id,
      });
    }

    // missed 기록 삽입
    await db.query(
      `INSERT INTO medication_logs (schedule_id, elder_id, status, taken_at, logged_by)
       VALUES ($1, $2, 'missed', NOW(), $2)
       ON CONFLICT DO NOTHING`,
      [sch.schedule_id, sch.elder_id]
    ).catch(() => null);
  }
}

// ── 스케줄러 시작 ────────────────────────────────────────────

let remindTask;
let escalationTask;

function startMedicationReminder() {
  if (remindTask) {
    console.warn('[복약 알림] 이미 실행 중');
    return;
  }

  // 매 분마다 복약 알림 체크
  remindTask = cron.schedule('* * * * *', async () => {
    try {
      await sendDueReminders();
    } catch (err) {
      console.error('[복약 알림] 오류:', err.message);
    }
  });

  // 15분마다 미확인 복약 에스컬레이션 체크
  escalationTask = cron.schedule('*/15 * * * *', async () => {
    try {
      await checkMissedMedications();
    } catch (err) {
      console.error('[복약 에스컬레이션] 오류:', err.message);
    }
  });

  console.log('[복약 알림] 스케줄러 시작됨 — 1분 간격 복약 체크, 15분 간격 에스컬레이션 체크');
}

function stopMedicationReminder() {
  if (remindTask)      { remindTask.stop();      remindTask      = null; }
  if (escalationTask)  { escalationTask.stop();  escalationTask  = null; }
  console.log('[복약 알림] 스케줄러 중지됨');
}

module.exports = { startMedicationReminder, stopMedicationReminder, sendDueReminders, checkMissedMedications };
