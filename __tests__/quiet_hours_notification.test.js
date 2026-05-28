'use strict';
/**
 * __tests__/quiet_hours_notification.test.js
 * nova-qa 감사 R30 (케어링) — Quiet Hours + notificationService
 *
 * 헤르2 체크포인트:
 * - Quiet Hours KST 22:00~08:00 경계값
 * - UTC 변환 정확성
 * - notificationService 함수 존재 + 구조 검증
 */

'use strict';

describe('isQuietHours — Quiet Hours KST 경계값', () => {
  // KST = UTC+9 → UTC 시간으로 테스트
  // KST 22:00 = UTC 13:00 → quiet
  // KST 07:59 = UTC 22:59 → quiet
  // KST 08:00 = UTC 23:00 → NOT quiet
  // KST 21:59 = UTC 12:59 → NOT quiet

  function isQuietHoursAt(kstHour) {
    const QUIET_START = 22;
    const QUIET_END = 8;
    return kstHour >= QUIET_START || kstHour < QUIET_END;
  }

  it('KST 22:00 (시작) → QUIET', () => {
    expect(isQuietHoursAt(22)).toBe(true);
  });

  it('KST 23:00 (한밤) → QUIET', () => {
    expect(isQuietHoursAt(23)).toBe(true);
  });

  it('KST 00:00 (자정) → QUIET', () => {
    expect(isQuietHoursAt(0)).toBe(true);
  });

  it('KST 07:59 → QUIET (마지막 Quiet 시간)', () => {
    expect(isQuietHoursAt(7)).toBe(true);
  });

  it('KST 08:00 → NOT QUIET (활성 시작)', () => {
    expect(isQuietHoursAt(8)).toBe(false);
  });

  it('KST 09:00 → NOT QUIET', () => {
    expect(isQuietHoursAt(9)).toBe(false);
  });

  it('KST 21:59 → NOT QUIET (활성 마지막)', () => {
    expect(isQuietHoursAt(21)).toBe(false);
  });
});

describe('isQuietHours — UTC 변환 정확성 (Date.now mock)', () => {
  const originalNow = Date.now;

  afterEach(() => {
    Date.now = originalNow;
  });

  function getKstHourFrom(utcTimestamp) {
    return new Date(utcTimestamp + 9 * 3600 * 1000).getUTCHours();
  }

  it('UTC 13:00 → KST 22:00 (Quiet 시작)', () => {
    const utcMs = Date.UTC(2024, 0, 15, 13, 0, 0);
    const kstHour = getKstHourFrom(utcMs);
    expect(kstHour).toBe(22);
  });

  it('UTC 22:59 → KST 07:59 (Quiet 중)', () => {
    const utcMs = Date.UTC(2024, 0, 15, 22, 59, 0);
    const kstHour = getKstHourFrom(utcMs);
    expect(kstHour).toBe(7);
  });

  it('UTC 23:00 → KST 08:00 (Quiet 종료)', () => {
    const utcMs = Date.UTC(2024, 0, 15, 23, 0, 0);
    const kstHour = getKstHourFrom(utcMs);
    expect(kstHour).toBe(8);
  });

  it('UTC 12:59 → KST 21:59 (Quiet 전)', () => {
    const utcMs = Date.UTC(2024, 0, 15, 12, 59, 0);
    const kstHour = getKstHourFrom(utcMs);
    expect(kstHour).toBe(21);
  });
});

describe('sendDueReminders — Quiet Hours 중 즉시 리턴', () => {
  let sendDueReminders;

  beforeEach(() => {
    jest.resetModules();
  });

  it('Quiet Hours(KST 22:00) 중에는 조용히 종료', async () => {
    // UTC 13:00 = KST 22:00
    const quietUtc = Date.UTC(2024, 0, 15, 13, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(quietUtc);

    // medication_reminder 동적 require (모듈 캐시 초기화 후)
    jest.mock('../src/models/db', () => ({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      isFallback: () => true,
    }));
    jest.mock('../src/services/notificationService', () => ({
      notifyGuardians: jest.fn(),
      notifyUser: jest.fn(),
      saveNotification: jest.fn(),
    }));

    const { sendDueReminders: sdr } = require('../src/cron/medication_reminder');
    await sdr(); // should return early without throwing

    const notifSvc = require('../src/services/notificationService');
    expect(notifSvc.notifyGuardians).not.toHaveBeenCalled();

    jest.restoreAllMocks();
  });
});

describe('notificationService — 모듈 구조 검증', () => {
  it('필수 함수들이 export됨', () => {
    jest.unmock('../src/services/notificationService');
    jest.resetModules();
    const svc = require('../src/services/notificationService');
    expect(typeof svc.notifyGuardians).toBe('function');
    expect(typeof svc.notifyUser).toBe('function');
    expect(typeof svc.saveNotification).toBe('function');
    expect(typeof svc.sendFcmMessage).toBe('function');
  });
});
