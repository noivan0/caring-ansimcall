"""
복약 알림 스케줄 DB 모델
법적: 복약 "관리" 금지 → "알림/리마인더" 표현 사용
민감정보(§23): 별도 명시적 동의 수집 필수
"""
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, Enum
from sqlalchemy.orm import declarative_base
import enum, datetime

Base = declarative_base()


class ConsentStatus(enum.Enum):
    PENDING = "pending"       # 동의 대기
    CONSENTED = "consented"   # 동의 완료
    REVOKED = "revoked"       # 동의 철회


class MedicationSchedule(Base):
    """
    복약 알림 스케줄 (의료기기 아님 — 알림 서비스)
    """
    __tablename__ = "medication_schedules"

    id = Column(Integer, primary_key=True)
    child_user_id = Column(Integer, nullable=False)          # 자녀(결제자)
    parent_phone = Column(String(20), nullable=False)        # 부모님 전화번호

    # 알림 설정 (복약 "관리" 아닌 "알림" 표현)
    medication_name = Column(String(100), nullable=False)    # 약 이름 (자녀 직접 입력)
    reminder_time = Column(String(10), nullable=False)       # "08:00"
    reminder_type = Column(String(20), default="ivr_call")   # ivr_call | push

    # 동의 관리 (개인정보보호법 §23 민감정보)
    parent_call_consent = Column(
        Enum(ConsentStatus),
        default=ConsentStatus.PENDING,
        nullable=False,
        comment="AI 전화 수신 동의 (정통망법 §50 필수)"
    )
    sensitive_data_consent = Column(
        Boolean,
        default=False,
        comment="복약데이터 민감정보 별도 동의 (개보법 §23 필수)"
    )
    health_share_consent = Column(
        Boolean,
        default=False,
        comment="부모 건강정보 자녀 공유 동의"
    )
    consent_date = Column(DateTime, nullable=True)

    # 응답 추적
    last_called_at = Column(DateTime, nullable=True)
    last_response = Column(String(20), nullable=True)  # "confirmed" | "deferred" | "no_answer"
    retry_count = Column(Integer, default=0)

    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))

    def can_send_reminder(self) -> bool:
        """
        알림 발송 가능 여부 검증
        동의 없으면 절대 발송 안 함
        """
        return (
            self.parent_call_consent == ConsentStatus.CONSENTED
            and self.sensitive_data_consent
            and self.is_active
        )
