'use strict';
/**
 * __tests__/notification_service_deep.test.js
 * nova-qa 감사 R31 — notificationService.js 심층 커버리지
 *
 * 대상 함수:
 *  - sendFcmMessage     (FCM 단건 발송)
 *  - saveNotification   (DB 알림 로그 저장)
 *  - notifyGuardians    (보호자 전원 FCM)
 *  - notifyUser         (단일 사용자 FCM)
 *  - buildNotificationText (타입별 텍스트 — 간접 검증)
 */

const admin = require('firebase-admin');
const db    = require('../src/models/db');

// Guardian 모델 mock
jest.mock('../src/models/user', () => ({
  Guardian: {
    findGuardiansByElder: jest.fn(),
  },
}));
const { Guardian } = require('../src/models/user');

// notificationService 는 firebase-admin 싱글턴을 내부에서 캐시하므로
// 매 describe 전 jest.resetModules() 불필요 — 이미 setup.js에서 admin mock 됨
let svc;
beforeAll(() => {
  svc = require('../src/services/notificationService');
});

beforeEach(() => {
  jest.clearAllMocks();
  // firebase messaging 기본 mock
  admin.messaging.mockReturnValue({
    send: jest.fn().mockResolvedValue('msg-id-123'),
  });
});

// ─────────────────────────────────────────────────────────────
// 1. sendFcmMessage
// ─────────────────────────────────────────────────────────────
describe('sendFcmMessage', () => {
  it('토큰 없으면 null 반환 (early return)', async () => {
    const result = await svc.sendFcmMessage(null, { title: 'T', body: 'B' });
    expect(result).toBeNull();
    expect(admin.messaging).not.toHaveBeenCalled();
  });

  it('빈 문자열 토큰도 null 반환', async () => {
    const result = await svc.sendFcmMessage('', { title: 'T', body: 'B' });
    expect(result).toBeNull();
  });

  it('정상 발송 → messageId 반환', async () => {
    const result = await svc.sendFcmMessage('valid-token', { title: '알림', body: '내용' });
    expect(result).toBe('msg-id-123');
    expect(admin.messaging).toHaveBeenCalled();
  });

  it('data 값이 모두 문자열로 변환됨', async () => {
    let capturedMessage;
    admin.messaging.mockReturnValue({
      send: jest.fn().mockImplementation((msg) => {
        capturedMessage = msg;
        return Promise.resolve('ok');
      }),
    });

    await svc.sendFcmMessage('tok', { title: 'T', body: 'B' }, { count: 3, flag: true, str: 'hello' });

    expect(capturedMessage.data).toEqual({ count: '3', flag: 'true', str: 'hello' });
  });

  it('priority=true → android.priority=high, apns-priority=10', async () => {
    let capturedMessage;
    admin.messaging.mockReturnValue({
      send: jest.fn().mockImplementation((msg) => {
        capturedMessage = msg;
        return Promise.resolve('high-ok');
      }),
    });

    await svc.sendFcmMessage('tok', { title: 'SOS', body: '긴급' }, {}, true);

    expect(capturedMessage.android.priority).toBe('high');
    expect(capturedMessage.android.notification.sound).toBe('emergency');
    expect(capturedMessage.apns.headers['apns-priority']).toBe('10');
    expect(capturedMessage.apns.payload.aps.sound).toBe('emergency.caf');
  });

  it('priority=false → android.priority=normal, apns-priority=5', async () => {
    let capturedMessage;
    admin.messaging.mockReturnValue({
      send: jest.fn().mockImplementation((msg) => {
        capturedMessage = msg;
        return Promise.resolve('normal-ok');
      }),
    });

    await svc.sendFcmMessage('tok', { title: '알림', body: '내용' }, {}, false);

    expect(capturedMessage.android.priority).toBe('normal');
    expect(capturedMessage.android.notification.sound).toBe('default');
    expect(capturedMessage.apns.headers['apns-priority']).toBe('5');
    expect(capturedMessage.apns.payload.aps.sound).toBe('default');
  });

  it('토큰 만료 에러 → null 반환 (warn 로그)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    admin.messaging.mockReturnValue({
      send: jest.fn().mockRejectedValue({
        code: 'messaging/registration-token-not-registered',
        message: '만료됨',
      }),
    });

    const result = await svc.sendFcmMessage('expired-tok', { title: 'T', body: 'B' });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[FCM] 만료된 토큰'));
    warnSpy.mockRestore();
  });

  it('기타 FCM 에러 → null 반환 (error 로그)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    admin.messaging.mockReturnValue({
      send: jest.fn().mockRejectedValue({
        code: 'messaging/internal-error',
        message: '서버 오류',
      }),
    });

    const result = await svc.sendFcmMessage('tok', { title: 'T', body: 'B' });
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith('[FCM] 발송 실패:', 'messaging/internal-error', '서버 오류');
    errSpy.mockRestore();
  });

  it('Firebase 앱 싱글턴 — 두 번째 호출에서 initializeApp 재호출 안 함', async () => {
    // sendFcmMessage 연속 2번 호출 → initializeApp은 최초 1회만
    await svc.sendFcmMessage('tok1', { title: 'T', body: 'B' });
    await svc.sendFcmMessage('tok2', { title: 'T', body: 'B' });
    // initializeApp은 setup.js에서 mock됨, 실제 호출 횟수 체크
    // admin.initializeApp mock이 몇 번 불렸는지 — 0 또는 1 (싱글턴)
    expect(admin.initializeApp.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. saveNotification
// ─────────────────────────────────────────────────────────────
describe('saveNotification', () => {
  it('성공 — db.query 올바른 파라미터로 호출', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await svc.saveNotification('user-1', 'HEALTH_ALERT', '건강 이상', '수치 확인', { value: 120 });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notifications'),
      ['user-1', 'HEALTH_ALERT', '건강 이상', '수치 확인', JSON.stringify({ value: 120 })]
    );
  });

  it('data 기본값 {} — JSON.stringify({}) 로 저장', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await svc.saveNotification('user-2', 'SOS_TRIGGERED', 'SOS', '긴급');

    const callArgs = db.query.mock.calls[0][1];
    expect(callArgs[4]).toBe('{}');
  });

  it('DB 에러 발생 → throw 없이 error 로그만', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockRejectedValue(new Error('DB 연결 실패'));

    await expect(svc.saveNotification('user-3', 'MEDICATION_TAKEN', '복약', '완료')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith('[Notification] DB 저장 실패:', 'DB 연결 실패');
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────
// 3. notifyGuardians
// ─────────────────────────────────────────────────────────────
describe('notifyGuardians', () => {
  it('보호자 없으면 즉시 return (FCM/DB 미호출)', async () => {
    Guardian.findGuardiansByElder.mockResolvedValue([]);

    await svc.notifyGuardians('elder-1', { type: 'SOS_TRIGGERED' });

    expect(admin.messaging).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('보호자 2명 → FCM 2번 + DB 2번 호출', async () => {
    Guardian.findGuardiansByElder.mockResolvedValue([
      { id: 'g-1', fcm_token: 'tok-g1' },
      { id: 'g-2', fcm_token: 'tok-g2' },
    ]);
    db.query.mockResolvedValue({ rows: [] });

    await svc.notifyGuardians('elder-1', { type: 'MEDICATION_TAKEN' });

    expect(admin.messaging).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('highPriority=true → FCM 발송 시 priority=true 전달', async () => {
    Guardian.findGuardiansByElder.mockResolvedValue([
      { id: 'g-1', fcm_token: 'sos-tok' },
    ]);
    db.query.mockResolvedValue({ rows: [] });

    let capturedPriority;
    admin.messaging.mockReturnValue({
      send: jest.fn().mockImplementation((msg) => {
        capturedPriority = msg.android.priority;
        return Promise.resolve('sos-msg');
      }),
    });

    await svc.notifyGuardians('elder-1', { type: 'SOS_TRIGGERED' }, { highPriority: true });

    expect(capturedPriority).toBe('high');
  });

  it('보호자 FCM 실패해도 Promise.allSettled → throw 없이 완료', async () => {
    Guardian.findGuardiansByElder.mockResolvedValue([
      { id: 'g-1', fcm_token: 'bad-tok' },
    ]);
    db.query.mockResolvedValue({ rows: [] });
    admin.messaging.mockReturnValue({
      send: jest.fn().mockRejectedValue(new Error('FCM 실패')),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(svc.notifyGuardians('elder-2', { type: 'HEALTH_ALERT' })).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it('보호자 DB 저장 실패해도 allSettled → throw 없이 완료', async () => {
    Guardian.findGuardiansByElder.mockResolvedValue([
      { id: 'g-1', fcm_token: 'tok-g1' },
    ]);
    db.query.mockRejectedValue(new Error('DB 오류'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(svc.notifyGuardians('elder-3', { type: 'MEDICATION_MISSED' })).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────
// 4. notifyUser
// ─────────────────────────────────────────────────────────────
describe('notifyUser', () => {
  it('user.fcm_token으로 FCM 발송 + DB 저장', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const user = { id: 'user-10', fcm_token: 'user-tok' };

    await svc.notifyUser(user, { type: 'MEDICATION_TAKEN' });

    expect(admin.messaging).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('highPriority=true 전달 → android.priority=high', async () => {
    db.query.mockResolvedValue({ rows: [] });
    let capturedPriority;
    admin.messaging.mockReturnValue({
      send: jest.fn().mockImplementation((msg) => {
        capturedPriority = msg.android.priority;
        return Promise.resolve('u-sos');
      }),
    });

    await svc.notifyUser({ id: 'u1', fcm_token: 'tok' }, { type: 'SOS_TRIGGERED' }, { highPriority: true });

    expect(capturedPriority).toBe('high');
  });

  it('fcm_token 없는 user → FCM null 반환 but DB 저장은 호출됨', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await svc.notifyUser({ id: 'u2', fcm_token: null }, { type: 'MEDICATION_MISSED' });

    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. buildNotificationText (notifyUser 통해 간접 검증)
// ─────────────────────────────────────────────────────────────
describe('buildNotificationText — 타입별 알림 텍스트', () => {
  beforeEach(() => {
    db.query.mockResolvedValue({ rows: [] });
  });

  async function getNotification(payload) {
    let capturedNotif;
    admin.messaging.mockReturnValue({
      send: jest.fn().mockImplementation((msg) => {
        capturedNotif = msg.notification;
        return Promise.resolve('ok');
      }),
    });
    await svc.notifyUser({ id: 'u', fcm_token: 'tok' }, payload);
    return capturedNotif;
  }

  it('SOS_TRIGGERED — 위치 있을 때 좌표 포함', async () => {
    const n = await getNotification({
      type: 'SOS_TRIGGERED',
      location: { latitude: 37.5665, longitude: 126.9780 },
    });
    expect(n.title).toBe('긴급 SOS 발생');
    expect(n.body).toContain('37.5665');
    expect(n.body).toContain('126.9780');
  });

  it('SOS_TRIGGERED — 위치 없을 때 기본 메시지', async () => {
    const n = await getNotification({ type: 'SOS_TRIGGERED' });
    expect(n.title).toBe('긴급 SOS 발생');
    expect(n.body).toBe('노인분이 SOS를 눌렀습니다.');
  });

  it('HEALTH_ALERT — alerts 배열 있을 때 join', async () => {
    const n = await getNotification({
      type: 'HEALTH_ALERT',
      alerts: [{ type: '혈압', value: 160 }, { type: '심박', value: 110 }],
    });
    expect(n.title).toBe('건강 이상 감지');
    expect(n.body).toContain('혈압: 160');
    expect(n.body).toContain('심박: 110');
  });

  it('HEALTH_ALERT — alerts 없을 때 기본 메시지', async () => {
    const n = await getNotification({ type: 'HEALTH_ALERT' });
    expect(n.body).toBe('건강 수치를 확인해주세요.');
  });

  it('SAFE_ZONE_EXIT — zoneName 있을 때', async () => {
    const n = await getNotification({ type: 'SAFE_ZONE_EXIT', zoneName: '집 근처' });
    expect(n.title).toBe('안전구역 이탈');
    expect(n.body).toContain('집 근처');
  });

  it('SAFE_ZONE_EXIT — zoneName 없을 때 기본값', async () => {
    const n = await getNotification({ type: 'SAFE_ZONE_EXIT' });
    expect(n.body).toBe('안전구역에서 이탈했습니다.');
  });

  it('MEDICATION_TAKEN — 고정 메시지', async () => {
    const n = await getNotification({ type: 'MEDICATION_TAKEN' });
    expect(n.title).toBe('복약 완료');
    expect(n.body).toBe('복약을 완료했습니다.');
  });

  it('MEDICATION_MISSED — medicationName 있을 때', async () => {
    const n = await getNotification({ type: 'MEDICATION_MISSED', medicationName: '혈압약' });
    expect(n.body).toContain('혈압약');
  });

  it('MEDICATION_MISSED — medicationName 없을 때 기본값', async () => {
    const n = await getNotification({ type: 'MEDICATION_MISSED' });
    expect(n.body).toContain('복약');
  });

  it('MEDICATION_ESCALATION — 3회 연속 미확인 제목', async () => {
    const n = await getNotification({ type: 'MEDICATION_ESCALATION', medicationName: '당뇨약' });
    expect(n.title).toContain('3회 연속');
    expect(n.body).toContain('당뇨약');
  });

  it('MEDICATION_ESCALATION — medicationName 없을 때 기본값', async () => {
    const n = await getNotification({ type: 'MEDICATION_ESCALATION' });
    expect(n.body).toContain('복약');
  });

  it('default — payload.title/body 그대로 사용', async () => {
    const n = await getNotification({ type: 'CUSTOM_TYPE', title: '커스텀 제목', body: '커스텀 내용' });
    expect(n.title).toBe('커스텀 제목');
    expect(n.body).toBe('커스텀 내용');
  });

  it('default — title/body 없으면 기본값', async () => {
    const n = await getNotification({ type: 'UNKNOWN' });
    expect(n.title).toBe('노부모케어 알림');
    expect(n.body).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────
// 6. notifyGuardians — buildNotificationText 간접 검증
// ─────────────────────────────────────────────────────────────
describe('notifyGuardians — 알림 텍스트 전달 검증', () => {
  it('SOS_TRIGGERED → highPriority=true 없이도 알림 텍스트 SOS 포함', async () => {
    Guardian.findGuardiansByElder.mockResolvedValue([
      { id: 'g-1', fcm_token: 'tok-g1' },
    ]);
    db.query.mockResolvedValue({ rows: [] });

    let capturedTitle;
    admin.messaging.mockReturnValue({
      send: jest.fn().mockImplementation((msg) => {
        capturedTitle = msg.notification.title;
        return Promise.resolve('ok');
      }),
    });

    await svc.notifyGuardians('elder-10', { type: 'SOS_TRIGGERED' });
    expect(capturedTitle).toBe('긴급 SOS 발생');
  });
});
