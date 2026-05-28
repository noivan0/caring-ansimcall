"""
복약 알림 스케줄러 (Celery)
- "복약 관리" → "복약 알림" 표현 사용
- 개인정보: 암호화 저장, 제3자 미제공
"""
from celery import Celery
from celery.schedules import crontab
from datetime import datetime
import logging

logger = logging.getLogger(__name__)
app = Celery("caring_scheduler")

# [R31-CELERY1] Broker/Backend URL 환경변수 필수 — 하드코딩 금지
# 미설정 시 기본값 amqp://guest:guest@localhost 사용 → 프로덕션 위험
import os as _os
_broker = _os.getenv("CELERY_BROKER_URL", "")
_backend = _os.getenv("CELERY_RESULT_BACKEND", "")
if _broker:
    app.conf.broker_url = _broker
if _backend:
    app.conf.result_backend = _backend
elif not _broker:
    logger.warning("[Celery] CELERY_BROKER_URL 미설정 — 프로덕션 전 필수 설정 필요")

# Celery Beat 자동 스케줄 등록 (PRD 명세: 30분 간격 미응답 체크)
app.conf.beat_schedule = {
    "check-unanswered-reminders-every-15min": {
        "task": "src.workers.scheduler.check_unanswered_reminders",
        "schedule": crontab(minute="*/15"),  # 15분마다 (PRD: 30분 미응답 체크 → 15분 폴링)
    },
}
app.conf.timezone = "Asia/Seoul"


@app.task(bind=True, max_retries=3)
def send_medication_reminder(self, schedule_id: int):
    """
    복약 알림 발송 태스크
    - IVR 전화 또는 FCM 푸시 선택
    - 부모님 동의 여부 사전 확인 필수
    """
    from src.services.ivr_service import make_reminder_call
    from src.api.models.schedule import MedicationSchedule, ConsentStatus
    import os
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    db_url = os.getenv("DATABASE_URL", "")
    if not db_url:
        logger.warning(f"[{schedule_id}] DATABASE_URL 미설정 — 건너뜀")
        return {"status": "skipped", "reason": "no_db_url"}

    try:
        engine = create_engine(db_url)
        Session = sessionmaker(bind=engine)
        with Session() as session:
            schedule = session.get(MedicationSchedule, schedule_id)
    except Exception as e:
        logger.error(f"[{schedule_id}] DB 조회 실패: {e}")
        raise self.retry(exc=e, countdown=60)

    if schedule is None:
        logger.warning(f"[{schedule_id}] 스케줄 미존재 — 건너뜀")
        return {"status": "skipped", "reason": "not_found"}

    if not schedule.can_send_reminder():
        logger.warning(f"[{schedule_id}] 부모님 동의 없음 — 발송 건너뜀")
        return {"status": "skipped", "reason": "no_consent"}

    base_url = os.getenv("API_BASE_URL", "https://caring.example.com")
    result = make_reminder_call(
        parent_phone=str(schedule.parent_phone),
        med_name=str(schedule.medication_name),  # 약 이름만 (약효/상호작용 정보 제공 X)
        callback_url=f"{base_url}/ivr/callback/{schedule_id}",
        retry_count=int(schedule.retry_count) if schedule.retry_count is not None else 0,  # type: ignore[arg-type]
    )

    logger.info(f"[{schedule_id}] 알림 발송: {result}")
    return result


@app.task
def check_unanswered_reminders():
    """
    미응답 알림 → 자녀에게 FCM 푸시 발송
    (119 자동 연결 X — 자녀 수동 판단 원칙)
    PRD 명세: 미응답 3회 → 보호자 전원 알림 (최대 5명, 앱 등록 기준)
    """
    from src.services.fcm_service import push_to_child
    from src.api.models.schedule import MedicationSchedule, ConsentStatus
    import os
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import sessionmaker

    db_url = os.getenv("DATABASE_URL", "")
    if not db_url:
        logger.warning("[check_unanswered] DATABASE_URL 미설정 — 건너뜀")
        return {"status": "skipped", "reason": "no_db_url"}

    try:
        engine = create_engine(db_url)
        Session = sessionmaker(bind=engine)
        with Session() as session:
            # 30분 이내 미응답 스케줄 조회
            rows = session.execute(text("""
                SELECT id, child_user_id, parent_phone, medication_name,
                       retry_count, last_called_at
                FROM medication_schedules
                WHERE is_active = true
                  AND parent_call_consent = 'consented'
                  AND last_response IS NULL
                  AND last_called_at IS NOT NULL
                  AND last_called_at < NOW() - INTERVAL '30 minutes'
                  AND retry_count < 3
            """)).fetchall()

        notified = 0
        for row in rows:
            schedule_id, child_user_id, parent_phone, med_name, retry_count, _ = row

            # 보호자 전원 FCM 알림 (실 구현: 가족 그룹에서 child FCM token 조회)
            # MVP: child_user_id 단일 → 배포 후 가족 그룹 멀티 수신자 확장
            try:
                result = push_to_child(
                    child_fcm_token=f"user_{child_user_id}_fcm_token",  # 배포 후 DB 조회로 교체
                    med_name=str(med_name),
                    schedule_id=int(schedule_id),
                    message=f"부모님이 '{med_name}' 복약 알림에 응답하지 않으셨습니다. ({retry_count+1}회차)",
                )
                logger.info(f"[{schedule_id}] 미응답 FCM 전송: {result}")
                notified += 1
            except Exception as e:
                logger.error(f"[{schedule_id}] FCM 전송 실패: {e}")

        return {"status": "done", "notified": notified}

    except Exception as e:
        logger.error(f"[check_unanswered] DB 오류: {e}")
        return {"status": "error", "detail": str(e)}
