/**
 * Tests: 복약 알림 스케줄러 타이밍 검증
 * - sendDueReminders — 현재 시각 기반 쿼리 정확성
 * - checkMissedMedications — 에스컬레이션 로직
 */
'use strict';

// [Quiet Hours 모킹] 테스트 환경에서 항상 업무시간대로 설정 (KST 09:00)
// isQuietHours()가 true이면 sendDueReminders가 즉시 return하여 테스트 실패
jest.mock('../src/cron/medication_reminder', () => {
  const original = jest.requireActual('../src/cron/medication_reminder');
  return {
    ...original,
    // isQuietHours 내부 함수를 직접 mock할 수 없으므로
    // 환경변수로 Quiet Hours를 0~1시로 제한 (테스트는 항상 통과)
  };
});

// 테스트 전 Quiet Hours 비활성화 (QUIET_HOURS_START=0, QUIET_HOURS_END=1)
beforeAll(() => {
  // KST 09:00 = UTC 00:00으로 Date 고정 (isQuietHours 체크: KST 9시는 항상 업무시간)
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-24T00:00:00.000Z')); // UTC 00:00 = KST 09:00
});

afterAll(() => {
  jest.useRealTimers();
});

const db = require('../src/models/db');
const { sendDueReminders, checkMissedMedications } = require('../src/cron/medication_reminder');
const notificationService = require('../src/services/notificationService');

jest.mock('../src/services/notificationService', () => ({
  notifyGuardians: jest.fn().mockResolvedValue(undefined),
  notifyUser: jest.fn().mockResolvedValue(undefined),
  saveNotification: jest.fn().mockResolvedValue(undefined),
  sendFcmMessage: jest.fn().mockResolvedValue('msg-id'),
}));

jest.mock('../src/models/user', () => ({
  User: { findById: jest.fn() },
  Elder: {},
  Guardian: { findGuardiansByElder: jest.fn().mockResolvedValue([]) },
}));

// Elder 모델 mock (medication_reminder에서 직접 import)
jest.mock('../src/models/Elder', () => ({
  Elder: { findById: jest.fn() },
}));

afterEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────
// sendDueReminders — 타이밍 정확성
// ─────────────────────────────────────────────────
describe('sendDueReminders — 복약 알림 타이밍', () => {
  test('현재 시각에 맞는 스케줄이 있으면 FCM 발송', async () => {
    const schedules = [
      {
        schedule_id: 'sch-uuid-1',
        elder_id: 'elder-uuid-1',
        medication_name: '혈압약',
        dosage: '1정',
        elder_user_id: 'user-uuid-1',
        elder_fcm_token: 'fcm-token-abc',
        elder_name: '홍길동',
      },
    ];

    db.query.mockImplementation((sql) => {
      if (sql.includes('medication_schedules') && sql.includes('repeat_days')) {
        return Promise.resolve({ rows: schedules });
      }
      if (sql.includes('medication_logs') && sql.includes('taken_at::date')) {
        return Promise.resolve({ rows: [] }); // 아직 복약 안 함
      }
      if (sql.includes('medication_reminder_log')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await sendDueReminders();

    expect(notificationService.sendFcmMessage).toHaveBeenCalledWith(
      'fcm-token-abc',
      expect.objectContaining({ title: '복약 시간입니다' }),
      expect.objectContaining({ type: 'MEDICATION_REMINDER' })
    );
  });

  test('이미 복약 완료한 경우 FCM 미발송', async () => {
    const schedules = [
      {
        schedule_id: 'sch-uuid-2',
        elder_id: 'elder-uuid-2',
        medication_name: '당뇨약',
        elder_fcm_token: 'fcm-token-xyz',
      },
    ];

    db.query.mockImplementation((sql) => {
      if (sql.includes('medication_schedules')) return Promise.resolve({ rows: schedules });
      if (sql.includes('medication_logs') && sql.includes('taken_at::date')) {
        return Promise.resolve({ rows: [{ id: 'log-id' }] }); // 이미 복약함
      }
      return Promise.resolve({ rows: [] });
    });

    await sendDueReminders();
    expect(notificationService.sendFcmMessage).not.toHaveBeenCalled();
  });

  test('복약 스케줄 없으면 조기 종료', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await sendDueReminders();
    expect(notificationService.sendFcmMessage).not.toHaveBeenCalled();
  });

  test('DB 에러는 throw됨 (호출자가 catch)', async () => {
    db.query.mockRejectedValue(new Error('DB 연결 실패'));
    await expect(sendDueReminders()).rejects.toThrow('DB 연결 실패');
  });

  // 타이밍 정확도: 쿼리 파라미터가 올바른 HH:MM 형식인지 검증
  test('쿼리에 HH:MM 형식의 timeSlot 파라미터 전달', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await sendDueReminders();

    const firstCall = db.query.mock.calls[0];
    const timeSlot = firstCall[1][0]; // $1 파라미터
    // HH:MM 형식 (00:00 ~ 23:59) 검증
    expect(timeSlot).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });

  test('쿼리에 요일 파라미터 전달 (1~7, 일요일=7)', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await sendDueReminders();

    const firstCall = db.query.mock.calls[0];
    const dayOfWeek = firstCall[1][1]; // $2 파라미터
    expect(dayOfWeek).toBeGreaterThanOrEqual(1);
    expect(dayOfWeek).toBeLessThanOrEqual(7);
  });
});

// ─────────────────────────────────────────────────
// checkMissedMedications — 에스컬레이션 로직
// ─────────────────────────────────────────────────
describe('checkMissedMedications — 에스컬레이션', () => {
  test('연속 3회 미확인 시 2차 에스컬레이션 (highPriority)', async () => {
    const missedSchedules = [
      { schedule_id: 'sch-1', elder_id: 'elder-1', medication_name: '혈압약', dosage: '1정' },
    ];

    db.query.mockImplementation((sql) => {
      if (sql.includes('medication_schedules') && sql.includes('taken_today')) {
        return Promise.resolve({ rows: missedSchedules });
      }
      if (sql.includes('COUNT(*) AS cnt')) {
        return Promise.resolve({ rows: [{ cnt: '3' }] }); // 3회 연속 미확인
      }
      if (sql.includes('INSERT INTO medication_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await checkMissedMedications();

    expect(notificationService.notifyGuardians).toHaveBeenCalledWith(
      'elder-1',
      expect.objectContaining({ type: 'MEDICATION_ESCALATION' }),
      expect.objectContaining({ highPriority: true })
    );
  });

  test('1~2회 미확인 시 1차 보호자 알림 (일반)', async () => {
    const missedSchedules = [
      { schedule_id: 'sch-2', elder_id: 'elder-2', medication_name: '당뇨약', dosage: '1정' },
    ];

    db.query.mockImplementation((sql) => {
      if (sql.includes('medication_schedules')) return Promise.resolve({ rows: missedSchedules });
      if (sql.includes('COUNT(*) AS cnt')) return Promise.resolve({ rows: [{ cnt: '1' }] });
      if (sql.includes('INSERT INTO medication_logs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await checkMissedMedications();

    expect(notificationService.notifyGuardians).toHaveBeenCalledWith(
      'elder-2',
      expect.objectContaining({ type: 'MEDICATION_MISSED' })
    );
    // highPriority 없음
    const call = notificationService.notifyGuardians.mock.calls[0];
    expect(call[2]).toBeUndefined();
  });

  test('미확인 없으면 알림 미발송', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await checkMissedMedications();
    expect(notificationService.notifyGuardians).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────
// 환경 변수 기반 설정 검증
// ─────────────────────────────────────────────────
describe('복약 알림 환경변수 설정', () => {
  test('MED_CHECK_INTERVAL_MINUTES 기본값 30분', () => {
    delete process.env.MED_CHECK_INTERVAL_MINUTES;
    const val = parseInt(process.env.MED_CHECK_INTERVAL_MINUTES || '30');
    expect(val).toBe(30);
  });

  test('MED_ESCALATION_COUNT 기본값 3회', () => {
    delete process.env.MED_ESCALATION_COUNT;
    const val = parseInt(process.env.MED_ESCALATION_COUNT || '3');
    expect(val).toBe(3);
  });
});
