"""
FCM 푸시 알림 서비스 (firebase-admin 6.6.0)
미응답 알림 → 자녀 앱에 푸시

법적 요건:
- 119 자동 연결 X — 자녀 수동 판단 원칙
- 메시지에 진단/처방 내용 포함 금지 (의료법)
"""
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import firebase_admin
    from firebase_admin import credentials, messaging

    _cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH")
    if _cred_path and not firebase_admin._apps:
        cred = credentials.Certificate(_cred_path)
        firebase_admin.initialize_app(cred)
    _FCM_AVAILABLE = bool(_cred_path and firebase_admin._apps)
except ImportError:
    _FCM_AVAILABLE = False
    logger.warning("firebase-admin 미설치 — FCM 푸시 비활성화")


def push_to_child(
    child_fcm_token: str,
    med_name: str,
    schedule_id: int,
    message: Optional[str] = None,
) -> dict:
    """
    자녀에게 부모 복약 미확인 알림 발송.
    - 약 이름만 포함 (약효/상호작용 정보 제공 X)
    - 119 자동 연결 없음 (자녀 수동 판단 원칙)
    """
    if not _FCM_AVAILABLE:
        logger.info(f"[FCM 비활성] schedule_id={schedule_id} 알림 시뮬레이션")
        return {"status": "simulated", "schedule_id": schedule_id}

    body = message or f"부모님께서 '{med_name}' 복약 알림에 응답하지 않으셨습니다."
    notification = messaging.Notification(
        title="복약 미확인 알림",
        body=body,
    )
    msg = messaging.Message(
        notification=notification,
        token=child_fcm_token,
        data={
            "schedule_id": str(schedule_id),
            "action": "check_parent",  # 자녀 앱 딥링크용
        },
    )
    try:
        response = messaging.send(msg)
        logger.info(f"[FCM 성공] schedule_id={schedule_id}, message_id={response}")
        return {"status": "sent", "message_id": response}
    except Exception as e:
        logger.error(f"[FCM 실패] schedule_id={schedule_id}: {e}")
        return {"status": "error", "detail": str(e)}
