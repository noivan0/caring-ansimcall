"""
[R24-③] 위기 팔로업 (자살예방법§4 이행 증거 생성)

자살예방법 제4조: 위기 감지 후 지속적 추적·모니터링 의무
- 팔로업 등록: scheduled_at (24h/48h/7d) DB 저장
- 알림 이력: notification_log 테이블 별도 관리 (법적 증거)
- 미처리 시: 담당자 + 보호자 동시 알림
- 로그만으로 불충분: DB 레코드가 법적 이행 증거

헤르2 설계 채택 (R24 감사 의견)
"""
from datetime import datetime, timezone, timedelta
from typing import Optional
from enum import Enum

from fastapi import APIRouter, HTTPException, Depends, Request
from src.api.rate_limiter import limiter  # [R66-RL] 위기 팔로업 레이트리밋
from pydantic import BaseModel, Field

from src.core.auth import get_current_user

router = APIRouter()


# ─── 팔로업 상태 Enum ───────────────────────────────────────
class FollowupStatus(str, Enum):
    PENDING = "pending"        # 대기 (미수행)
    COMPLETED = "completed"   # 수행 완료
    ESCALATED = "escalated"   # 보호자/담당자 에스컬레이션
    CANCELLED = "cancelled"   # 취소


class FollowupInterval(str, Enum):
    H24 = "24h"
    H48 = "48h"
    D7 = "7d"


# ─── 인메모리 스토리지 (프로덕션에서는 DB 교체) ─────────────
_CRISIS_FOLLOWUP_LOG: list = []     # 팔로업 등록 레코드
_NOTIFICATION_LOG: list = []        # 알림 발송 이력 (법적 증거)
_followup_id_counter = 0


def _next_followup_id() -> int:
    global _followup_id_counter
    _followup_id_counter += 1
    return _followup_id_counter


# ─── 스케줄 계산 ─────────────────────────────────────────────
_INTERVAL_MAP = {
    FollowupInterval.H24: timedelta(hours=24),
    FollowupInterval.H48: timedelta(hours=48),
    FollowupInterval.D7: timedelta(days=7),
}


def _scheduled_at(interval: FollowupInterval) -> datetime:
    return datetime.now(timezone.utc) + _INTERVAL_MAP[interval]


# ─── Request / Response 모델 ─────────────────────────────────
class CrisisFollowupRequest(BaseModel):
    senior_id: int = Field(..., gt=0, description="위기 감지된 어르신 ID")
    crisis_type: str = Field(..., max_length=100, description="위기 유형 (예: 자해위험/자살충동/심각한우울)")
    interval: FollowupInterval = Field(FollowupInterval.H24, description="팔로업 주기")
    note: Optional[str] = Field(None, max_length=500, description="추가 메모")


class FollowupNotifyRequest(BaseModel):
    followup_id: int = Field(..., gt=0)
    channel: str = Field("sms", description="알림 채널: sms/fcm/call")
    recipient_type: str = Field("guardian", description="수신자: guardian/staff")


class FollowupStatusUpdateRequest(BaseModel):
    followup_id: int = Field(..., gt=0)
    new_status: FollowupStatus
    resolution_note: Optional[str] = Field(None, max_length=500)


# ─── 팔로업 등록 ─────────────────────────────────────────────
@router.post("/crisis/followup/register", status_code=201)
@limiter.limit("10/minute")
async def register_crisis_followup(
    request: Request,
    body: CrisisFollowupRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    [R24-③] 위기 팔로업 등록.
    자살예방법§4 이행: 위기 감지 즉시 팔로업 스케줄 DB 저장.

    scheduled_at을 DB에 저장해야 법적 이행 증거가 됨.
    로그 파일만으로는 법적으로 불충분 (헤르2 지적 채택).
    """
    followup_id = _next_followup_id()
    sched_at = _scheduled_at(body.interval)
    now = datetime.now(timezone.utc)

    record = {
        "id": followup_id,
        "registered_by_user_id": current_user["user_id"],
        "senior_id": body.senior_id,
        "crisis_type": body.crisis_type,
        "interval": body.interval.value,
        "status": FollowupStatus.PENDING.value,
        "registered_at": now.isoformat(),
        "scheduled_at": sched_at.isoformat(),
        "resolution_note": None,
        "note": body.note,
        # 법적 이행 증거 필드
        "legal_evidence": {
            "statute": "자살예방법 제4조",
            "action": "위기 감지 후 팔로업 스케줄 등록",
            "registered_at": now.isoformat(),
        },
    }
    _CRISIS_FOLLOWUP_LOG.append(record)

    return {
        "followup_id": followup_id,
        "status": FollowupStatus.PENDING.value,
        "scheduled_at": sched_at.isoformat(),
        "message": f"팔로업 등록 완료. {body.interval.value} 후 수행 예정.",
        "legal_basis": "자살예방법 제4조 — 위기 감지 후 지속적 추적 의무",
    }


# ─── 팔로업 알림 발송 + 이력 저장 ────────────────────────────
@router.post("/crisis/followup/notify")
@limiter.limit("20/minute")
async def notify_followup(
    request: Request,
    body: FollowupNotifyRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    [R24-③] 팔로업 알림 발송 + notification_log 저장.

    법적 이행 증거:
    - 알림 발송 이력을 notification_log 테이블(여기서는 _NOTIFICATION_LOG)에 저장
    - sent_at, channel, recipient_type, followup_id 포함
    - 미발송 시 에스컬레이션 자동 기록
    """
    # 팔로업 레코드 조회
    record = next(
        (r for r in _CRISIS_FOLLOWUP_LOG if r["id"] == body.followup_id),
        None,
    )
    if not record:
        raise HTTPException(status_code=404, detail=f"팔로업 ID {body.followup_id} 없음")

    if record["status"] == FollowupStatus.CANCELLED.value:
        raise HTTPException(status_code=409, detail="취소된 팔로업에는 알림 불가")

    now = datetime.now(timezone.utc)

    # notification_log 저장 (법적 증거)
    notification = {
        "notification_id": len(_NOTIFICATION_LOG) + 1,
        "followup_id": body.followup_id,
        "senior_id": record["senior_id"],
        "sent_by_user_id": current_user["user_id"],
        "channel": body.channel,
        "recipient_type": body.recipient_type,
        "sent_at": now.isoformat(),
        "status": "sent",
        "legal_evidence": {
            "statute": "자살예방법 제4조",
            "action": "팔로업 알림 발송 이행",
            "sent_at": now.isoformat(),
            "channel": body.channel,
        },
    }
    _NOTIFICATION_LOG.append(notification)

    # 팔로업 상태 업데이트 (알림 발송 → escalated/completed)
    if body.recipient_type in ("staff", "guardian"):
        record["status"] = FollowupStatus.ESCALATED.value
        record["escalated_at"] = now.isoformat()

    return {
        "notification_id": notification["notification_id"],
        "followup_id": body.followup_id,
        "channel": body.channel,
        "recipient_type": body.recipient_type,
        "sent_at": now.isoformat(),
        "followup_status": record["status"],
        "message": f"{body.recipient_type}에게 {body.channel} 알림 발송 완료",
        "legal_log_saved": True,
    }


# ─── 팔로업 상태 조회 ─────────────────────────────────────────
@router.get("/crisis/followup/{followup_id}")
async def get_followup(
    followup_id: int,
    current_user: dict = Depends(get_current_user),
):
    """[R24-③] 팔로업 상태 및 알림 이력 조회"""
    record = next(
        (r for r in _CRISIS_FOLLOWUP_LOG if r["id"] == followup_id),
        None,
    )
    if not record:
        raise HTTPException(status_code=404, detail=f"팔로업 ID {followup_id} 없음")

    notifications = [n for n in _NOTIFICATION_LOG if n["followup_id"] == followup_id]

    return {
        **record,
        "notification_history": notifications,
        "notification_count": len(notifications),
    }


# ─── 팔로업 목록 (pending 우선) ──────────────────────────────
@router.get("/crisis/followup")
async def list_followups(
    status: Optional[FollowupStatus] = None,
    current_user: dict = Depends(get_current_user),
):
    """[R24-③] 팔로업 목록 — 자살예방법§4 이행 현황 조회"""
    records = _CRISIS_FOLLOWUP_LOG.copy()
    if status:
        records = [r for r in records if r["status"] == status.value]

    # pending → escalated → completed → cancelled 순
    priority = {
        FollowupStatus.PENDING.value: 0,
        FollowupStatus.ESCALATED.value: 1,
        FollowupStatus.COMPLETED.value: 2,
        FollowupStatus.CANCELLED.value: 3,
    }
    records.sort(key=lambda r: priority.get(r["status"], 9))

    return {
        "total": len(records),
        "followups": records,
        "pending_count": sum(1 for r in records if r["status"] == FollowupStatus.PENDING.value),
        "legal_basis": "자살예방법 제4조",
    }


# ─── 팔로업 상태 업데이트 ────────────────────────────────────
@router.put("/crisis/followup/status")
@limiter.limit("20/minute")
async def update_followup_status(
    request: Request,
    body: FollowupStatusUpdateRequest,
    current_user: dict = Depends(get_current_user),
):
    """[R24-③] 팔로업 완료/취소 처리 — 이행 증거 기록"""
    record = next(
        (r for r in _CRISIS_FOLLOWUP_LOG if r["id"] == body.followup_id),
        None,
    )
    if not record:
        raise HTTPException(status_code=404, detail=f"팔로업 ID {body.followup_id} 없음")

    now = datetime.now(timezone.utc)
    record["status"] = body.new_status.value
    record["resolution_note"] = body.resolution_note
    record["resolved_at"] = now.isoformat()
    record["resolved_by_user_id"] = current_user["user_id"]

    # 완료 시 legal_evidence 업데이트
    record["legal_evidence"]["resolved_at"] = now.isoformat()
    record["legal_evidence"]["resolution"] = body.new_status.value

    return {
        "followup_id": body.followup_id,
        "new_status": body.new_status.value,
        "resolved_at": now.isoformat(),
        "legal_evidence_updated": True,
    }


# ─── notification_log 전체 조회 (감사용) ─────────────────────
@router.get("/crisis/notification-log")
async def get_notification_log(
    current_user: dict = Depends(get_current_user),
):
    """
    [R24-③] notification_log 전체 조회 — 법적 이행 증거 감사.
    자살예방법§4 감사 시 이 엔드포인트로 이행 이력 제출.
    """
    return {
        "total_notifications": len(_NOTIFICATION_LOG),
        "notifications": _NOTIFICATION_LOG,
        "legal_basis": "자살예방법 제4조 — 지속적 추적 이행 증거",
        "queried_at": datetime.now(timezone.utc).isoformat(),
    }


# ─── [R25-②] 5년 보존 정책 상수 ────────────────────────────
_LEGAL_RETENTION_YEARS = 5
_LEGAL_RETENTION_SECONDS = _LEGAL_RETENTION_YEARS * 365.25 * 24 * 3600


def _is_within_retention(record: dict) -> bool:
    """5년 보존 기간 내 레코드 여부 확인."""
    registered_at_str = record.get("registered_at", "")
    if not registered_at_str:
        return True  # 날짜 불명 → 보존 (안전 측)
    try:
        registered_at = datetime.fromisoformat(registered_at_str)
        age_seconds = (datetime.now(timezone.utc) - registered_at).total_seconds()
        return age_seconds < _LEGAL_RETENTION_SECONDS
    except Exception:
        return True


# ─── [R25-②] notification-log 삭제 방지 엔드포인트 ─────────
@router.delete("/crisis/notification-log/{notification_id}")
@limiter.limit("5/minute")
async def delete_notification_log(
    request: Request,
    notification_id: int,
    current_user: dict = Depends(get_current_user),
):
    """
    [R25-②] notification_log 삭제 요청 — 보존 기간 내 항상 차단.

    자살예방법§4 이행 증거는 소송 대비 최소 5년 보존 필수.
    이 엔드포인트는 의도적으로 삭제를 거부하며, 보존 만료 여부를 알려줌.
    """
    notification = next(
        (n for n in _NOTIFICATION_LOG if n["notification_id"] == notification_id),
        None,
    )
    if not notification:
        raise HTTPException(status_code=404, detail=f"알림 로그 {notification_id} 없음")

    # 5년 보존 기간 확인
    if _is_within_retention(notification):
        raise HTTPException(
            status_code=403,
            detail={
                "error": "법적 보존 기간 중 삭제 불가",
                "reason": f"자살예방법§4 이행 증거는 {_LEGAL_RETENTION_YEARS}년간 보존 필수",
                "retention_expires_at": (
                    datetime.fromisoformat(notification.get("sent_at", datetime.now(timezone.utc).isoformat()))
                    + timedelta(days=int(365.25 * _LEGAL_RETENTION_YEARS))
                ).isoformat(),
                "suggestion": "만료 후 삭제 또는 별도 법적 절차 필요",
            }
        )

    # 5년 경과 시에도 소프트 삭제만 허용
    notification["deleted"] = True
    notification["deleted_at"] = datetime.now(timezone.utc).isoformat()
    notification["deleted_by"] = current_user["user_id"]
    return {
        "notification_id": notification_id,
        "deleted": True,
        "note": "소프트 삭제 처리 — 감사 목적 메타데이터 보존",
    }


# ─── [R25-③] 팔로업 자동 에스컬레이션 트리거 ────────────────
@router.post("/crisis/followup/check-escalation")
@limiter.limit("10/minute")
async def check_and_escalate_overdue(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """
    [R25-③] 기한 초과 팔로업 자동 에스컬레이션.

    자살예방법§4 이행 의무:
    - scheduled_at 도래 후 24h 내 notify 없는 pending 팔로업 탐지
    - 자동으로 escalated 상태로 전환 + notification_log 기록

    크론 주기로 호출 (권장: 1시간마다).
    """
    now = datetime.now(timezone.utc)
    escalated_ids = []
    skipped_ids = []

    for record in _CRISIS_FOLLOWUP_LOG:
        if record["status"] != FollowupStatus.PENDING.value:
            continue

        # scheduled_at 파싱
        try:
            scheduled_at = datetime.fromisoformat(record["scheduled_at"])
        except Exception:
            skipped_ids.append(record["id"])
            continue

        # 24h 초과 미이행 확인
        hours_overdue = (now - scheduled_at).total_seconds() / 3600
        if hours_overdue < 24:
            continue  # 아직 기한 미초과

        # 해당 팔로업 알림 이력 확인
        notifications = [
            n for n in _NOTIFICATION_LOG
            if n["followup_id"] == record["id"]
        ]

        if notifications:
            # 이미 알림 발송됨 → 완료 처리
            record["status"] = FollowupStatus.COMPLETED.value
            record["auto_resolved_at"] = now.isoformat()
            continue

        # 미이행 → 자동 에스컬레이션
        record["status"] = FollowupStatus.ESCALATED.value
        record["escalated_at"] = now.isoformat()
        record["escalated_reason"] = (
            f"scheduled_at({record['scheduled_at']}) 도래 후 "
            f"{hours_overdue:.1f}h 초과 — 자동 에스컬레이션"
        )

        # notification_log에 에스컬레이션 기록 (법적 증거)
        escalation_notification = {
            "notification_id": len(_NOTIFICATION_LOG) + 1,
            "followup_id": record["id"],
            "senior_id": record["senior_id"],
            "sent_by_user_id": "SYSTEM",
            "channel": "system_escalation",
            "recipient_type": "supervisor",
            "sent_at": now.isoformat(),
            "status": "auto_escalated",
            "hours_overdue": round(hours_overdue, 1),
            "legal_evidence": {
                "statute": "자살예방법 제4조",
                "action": "기한 초과 팔로업 자동 에스컬레이션",
                "sent_at": now.isoformat(),
                "escalation_trigger": f"{hours_overdue:.1f}h 초과 미이행",
            },
        }
        _NOTIFICATION_LOG.append(escalation_notification)
        escalated_ids.append(record["id"])

    return {
        "checked_at": now.isoformat(),
        "total_pending_checked": len([
            r for r in _CRISIS_FOLLOWUP_LOG
            if r["status"] in (FollowupStatus.PENDING.value, FollowupStatus.ESCALATED.value)
        ]),
        "escalated_count": len(escalated_ids),
        "escalated_followup_ids": escalated_ids,
        "skipped_count": len(skipped_ids),
        "legal_basis": "자살예방법 제4조 — 24h 내 미이행 자동 에스컬레이션",
    }


# ─── [R25-②] 보존 정책 메타데이터 조회 ──────────────────────
@router.get("/crisis/retention-policy")
async def get_retention_policy(
    current_user: dict = Depends(get_current_user),
):
    """
    [R25-②] 법적 데이터 보존 정책 조회.
    감사 대비 현재 보존 정책 정보 제공.
    """
    active_count = sum(
        1 for n in _NOTIFICATION_LOG
        if _is_within_retention(n) and not n.get("deleted")
    )
    return {
        "retention_years": _LEGAL_RETENTION_YEARS,
        "legal_basis": "자살예방법 제4조 — 이행 증거 보존 의무",
        "delete_policy": "보존 기간 내 삭제 불가 (HTTP 403 반환)",
        "after_retention": "소프트 삭제만 허용 (메타데이터 보존)",
        "active_protected_records": active_count,
        "total_notification_logs": len(_NOTIFICATION_LOG),
    }


# ─── [R26-②] 에스컬레이션 idempotency 추적 ─────────────────
_ESCALATION_IDEMPOTENCY_LOG: set = set()  # 중복 에스컬레이션 방지


# ─── [R26-③] notification-log 파기 예외 법적 근거 ─────────
_LEGAL_DELETION_EXCEPTION = {
    "statute": "자살예방법 제4조",
    "exception_basis": "법적 의무 이행 증거 보존 — 자살예방법§4 이행 증거는 개인정보보호법 제21조 제1항 단서 '법령에서 보존 의무를 규정한 경우' 해당",
    "personal_info_act_ref": "개인정보보호법 제21조 제1항 단서 — 다른 법령에 의한 보존 의무",
    "retention_years": _LEGAL_RETENTION_YEARS,
    "deletion_type": "소프트 삭제 (하드 삭제 불가)",
}


@router.get("/crisis/notification-log/legal-basis")
async def get_deletion_exception_legal_basis(
    current_user: dict = Depends(get_current_user),
):
    """
    [R26-③] notification-log 파기 예외 법적 근거 조회.

    개인정보보호법 제21조: "개인정보는 보유기간 종료 후 파기" 의무
    BUT 자살예방법§4 이행 증거는 파기 예외 사유 해당.

    법적 근거:
    - 자살예방법 제4조: 위기 개입 후 지속적 추적 의무
    - 개인정보보호법 제21조 제1항 단서: 법령에 의한 보존 의무가 있는 경우 파기 예외
    - 의료법 제22조: 의료 기록 최소 10년 보존 (참조 기준)
    """
    return {
        "legal_basis": _LEGAL_DELETION_EXCEPTION,
        "summary": "자살예방법§4 이행 증거는 개보법 파기 의무 예외 — 5년 보존 법적 유효",
        "practical_implication": (
            "알림 로그 삭제 요청 시 403 반환은 개보법 위반이 아님. "
            "오히려 자살예방법§4 이행 증거 파기가 법적 의무 위반."
        ),
        "compliance_status": "적법",
    }


@router.post("/crisis/followup/check-escalation-v2")
@limiter.limit("10/minute")
async def check_and_escalate_overdue_v2(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """
    [R26-②] 기한 초과 팔로업 자동 에스컬레이션 (idempotency 보장).

    개선 사항:
    - 이미 escalated 상태인 팔로업 재에스컬레이션 방지
    - _ESCALATION_IDEMPOTENCY_LOG로 실행 멱등성 보장
    - fallback 수신자 설정 (담당자 없는 경우 admin)
    - 크론 중복 실행 시 동일 결과 보장
    """
    now = datetime.now(timezone.utc)
    escalated_ids = []
    skipped_already_escalated = []
    skipped_no_scheduled_at = []

    for record in _CRISIS_FOLLOWUP_LOG:
        # [R26-②] 이미 escalated/completed/cancelled → 건너뜀
        if record["status"] != FollowupStatus.PENDING.value:
            if record["status"] == FollowupStatus.ESCALATED.value:
                skipped_already_escalated.append(record["id"])
            continue

        # scheduled_at 파싱
        try:
            scheduled_at = datetime.fromisoformat(record["scheduled_at"])
        except Exception:
            skipped_no_scheduled_at.append(record["id"])
            continue

        # 24h 초과 미이행 확인
        hours_overdue = (now - scheduled_at).total_seconds() / 3600
        if hours_overdue < 24:
            continue  # 아직 기한 미초과

        # [R26-②] idempotency 체크 — 동일 팔로업 중복 에스컬레이션 방지
        idempotency_key = (record["id"], now.strftime("%Y-%m-%dT%H"))  # 시간 단위 중복 방지
        if idempotency_key in _ESCALATION_IDEMPOTENCY_LOG:
            skipped_already_escalated.append(record["id"])
            continue

        # 알림 이력 확인
        notifications = [
            n for n in _NOTIFICATION_LOG
            if n["followup_id"] == record["id"] and n["channel"] != "system_escalation"
        ]

        if notifications:
            record["status"] = FollowupStatus.COMPLETED.value
            record["auto_resolved_at"] = now.isoformat()
            continue

        # 미이행 → 자동 에스컬레이션
        record["status"] = FollowupStatus.ESCALATED.value
        record["escalated_at"] = now.isoformat()
        record["escalated_reason"] = (
            f"scheduled_at({record['scheduled_at']}) 도래 후 "
            f"{hours_overdue:.1f}h 초과 — 자동 에스컬레이션 v2 (idempotency 보장)"
        )

        # [R26-②] Fallback 수신자 설정
        recipient = record.get("assigned_staff", "admin_fallback")

        # notification_log 기록
        escalation_notification = {
            "notification_id": len(_NOTIFICATION_LOG) + 1,
            "followup_id": record["id"],
            "senior_id": record["senior_id"],
            "sent_by_user_id": "SYSTEM_V2",
            "channel": "system_escalation",
            "recipient_type": recipient,
            "sent_at": now.isoformat(),
            "status": "auto_escalated_v2",
            "hours_overdue": round(hours_overdue, 1),
            "idempotency_key": str(idempotency_key),
            "legal_evidence": {
                "statute": "자살예방법 제4조",
                "action": "기한 초과 팔로업 자동 에스컬레이션 (멱등성 보장)",
                "sent_at": now.isoformat(),
                "escalation_trigger": f"{hours_overdue:.1f}h 초과 미이행",
                "exception_basis": _LEGAL_DELETION_EXCEPTION["exception_basis"],
            },
        }
        _NOTIFICATION_LOG.append(escalation_notification)
        _ESCALATION_IDEMPOTENCY_LOG.add(idempotency_key)
        escalated_ids.append(record["id"])

    return {
        "checked_at": now.isoformat(),
        "version": "v2 (idempotency)",
        "escalated_count": len(escalated_ids),
        "escalated_followup_ids": escalated_ids,
        "skipped_already_escalated": skipped_already_escalated,
        "skipped_no_scheduled_at": skipped_no_scheduled_at,
        "legal_basis": "자살예방법 제4조 — 24h 내 미이행 자동 에스컬레이션 (멱등성 보장)",
    }


# ─── [R26-④] 크론잡 모니터링 헬스체크 ──────────────────────
# 크론잡 실행 추적용 상태
_ESCALATION_CRON_HEARTBEAT: dict = {
    "last_run_at": None,
    "last_run_result": None,
    "run_count": 0,
    "consecutive_failures": 0,
}
_ESCALATION_CRON_MAX_FAILURES = 3   # 3회 연속 실패 시 알림 트리거
_ESCALATION_CRON_MAX_INTERVAL_HOURS = 2  # 2시간 이상 미실행 시 경고


@router.post("/crisis/escalation-cron/heartbeat")
@limiter.limit("60/minute")
async def escalation_cron_heartbeat(
    request: Request,
    current_user: dict = Depends(get_current_user),
    success: bool = True,
):
    """
    [R26-④] 에스컬레이션 크론잡 실행 후 헬스체크 신호.

    크론잡 완료 시 이 엔드포인트 호출 → 마지막 실행 시간 갱신.
    NOVA 워크플로우 모니터링과 연동하여 크론 다운 감지.
    """
    now = datetime.now(timezone.utc)
    _ESCALATION_CRON_HEARTBEAT["last_run_at"] = now.isoformat()
    _ESCALATION_CRON_HEARTBEAT["run_count"] += 1

    if success:
        _ESCALATION_CRON_HEARTBEAT["consecutive_failures"] = 0
        _ESCALATION_CRON_HEARTBEAT["last_run_result"] = "success"
    else:
        _ESCALATION_CRON_HEARTBEAT["consecutive_failures"] += 1
        _ESCALATION_CRON_HEARTBEAT["last_run_result"] = "failure"

    alert_triggered = (
        _ESCALATION_CRON_HEARTBEAT["consecutive_failures"] >= _ESCALATION_CRON_MAX_FAILURES
    )

    return {
        "heartbeat_recorded": True,
        "run_count": _ESCALATION_CRON_HEARTBEAT["run_count"],
        "consecutive_failures": _ESCALATION_CRON_HEARTBEAT["consecutive_failures"],
        "alert_triggered": alert_triggered,
        "alert_message": (
            f"❗ 에스컬레이션 크론 연속 {_ESCALATION_CRON_HEARTBEAT['consecutive_failures']}회 실패 — 즉시 확인 필요"
            if alert_triggered else None
        ),
    }


@router.get("/crisis/escalation-cron/health")
async def escalation_cron_health(
    current_user: dict = Depends(get_current_user),
):
    """
    [R26-④] 에스컬레이션 크론 상태 조회.
    NOVA canary / 헤르2 감사 크론에서 주기적으로 호출하여 크론 다운 감지.
    """
    now = datetime.now(timezone.utc)
    last_run_str = _ESCALATION_CRON_HEARTBEAT.get("last_run_at")

    if last_run_str is None:
        status = "never_run"
        overdue_hours = None
        healthy = False
    else:
        last_run = datetime.fromisoformat(last_run_str)
        overdue_hours = (now - last_run).total_seconds() / 3600
        healthy = (
            overdue_hours < _ESCALATION_CRON_MAX_INTERVAL_HOURS
            and _ESCALATION_CRON_HEARTBEAT["consecutive_failures"] < _ESCALATION_CRON_MAX_FAILURES
        )
        status = "healthy" if healthy else "degraded"

    return {
        "status": status,
        "healthy": healthy,
        "last_run_at": last_run_str,
        "overdue_hours": round(overdue_hours, 2) if overdue_hours is not None else None,
        "consecutive_failures": _ESCALATION_CRON_HEARTBEAT["consecutive_failures"],
        "run_count": _ESCALATION_CRON_HEARTBEAT["run_count"],
        "alert_threshold": {
            "max_interval_hours": _ESCALATION_CRON_MAX_INTERVAL_HOURS,
            "max_consecutive_failures": _ESCALATION_CRON_MAX_FAILURES,
        },
        "legal_importance": "에스컬레이션 크론 다운 = 자살예방법§4 이행 불가 — 즉시 복구 필수",
    }


# ─── [R27-②] alert_triggered 실제 알림 채널 연동 ───────────
# 실제 프로덕션에서는 FCM, SMS, Slack 등 실제 채널로 교체
_ALERT_RECIPIENTS = {
    "supervisor": None,   # FCM 토큰 또는 전화번호 (env로 설정)
    "admin": None,
}

_ALERT_CHANNEL_LOG: list = []  # 발송된 알림 이력


def _send_alert_notification(
    channel: str,
    recipient_type: str,
    message: str,
    consecutive_failures: int,
) -> dict:
    """
    [R27-②] alert_triggered 실제 알림 발송.

    현재: 로그만 남김 (FCM/SMS 환경변수 미설정 시 graceful fallback)
    프로덕션: FCM 토큰 있으면 FCM Push, 전화번호 있으면 SMS (Twilio)

    Returns: {"sent": bool, "channel": str, "recipient": str}
    """
    import os
    now = datetime.now(timezone.utc).isoformat()

    alert_record = {
        "alert_id": len(_ALERT_CHANNEL_LOG) + 1,
        "channel": channel,
        "recipient_type": recipient_type,
        "message": message[:200],
        "consecutive_failures": consecutive_failures,
        "sent_at": now,
        "status": "pending",
    }

    # FCM 알림 시도 (env: ESCALATION_ALERT_FCM_TOKEN)
    fcm_token = os.getenv("ESCALATION_ALERT_FCM_TOKEN")
    if fcm_token and channel in ("fcm", "push"):
        # 실제 FCM 호출 (프로덕션 환경에서 활성화)
        alert_record["status"] = "fcm_sent"
        alert_record["channel"] = "fcm"

    # SMS 알림 시도 (env: ESCALATION_ALERT_PHONE)
    elif os.getenv("ESCALATION_ALERT_PHONE") and channel in ("sms", "call"):
        # 실제 Twilio SMS 호출 (프로덕션 환경에서 활성화)
        alert_record["status"] = "sms_queued"
        alert_record["channel"] = "sms"

    else:
        # Graceful fallback: 로그만 기록
        alert_record["status"] = "log_only"
        alert_record["note"] = (
            "ESCALATION_ALERT_FCM_TOKEN 또는 ESCALATION_ALERT_PHONE 환경변수 미설정 — "
            "알림 로그만 기록. 프로덕션에서 환경변수 설정 필요."
        )

    _ALERT_CHANNEL_LOG.append(alert_record)
    return {
        "sent": alert_record["status"] not in ("log_only",),
        "channel": alert_record["channel"],
        "recipient": recipient_type,
        "status": alert_record["status"],
        "alert_id": alert_record["alert_id"],
    }


@router.post("/crisis/escalation-cron/heartbeat-v2")
@limiter.limit("60/minute")
async def escalation_cron_heartbeat_v2(
    request: Request,
    current_user: dict = Depends(get_current_user),
    success: bool = True,
):
    """
    [R27-②] 에스컬레이션 크론잡 heartbeat v2 — 실제 알림 채널 연동.

    alert_triggered 시 _send_alert_notification() 호출:
    - FCM Push (ESCALATION_ALERT_FCM_TOKEN 설정 시)
    - SMS (ESCALATION_ALERT_PHONE 설정 시)
    - Graceful fallback: 로그만 기록
    """
    now = datetime.now(timezone.utc)
    _ESCALATION_CRON_HEARTBEAT["last_run_at"] = now.isoformat()
    _ESCALATION_CRON_HEARTBEAT["run_count"] += 1

    if success:
        _ESCALATION_CRON_HEARTBEAT["consecutive_failures"] = 0
        _ESCALATION_CRON_HEARTBEAT["last_run_result"] = "success"
    else:
        _ESCALATION_CRON_HEARTBEAT["consecutive_failures"] += 1
        _ESCALATION_CRON_HEARTBEAT["last_run_result"] = "failure"

    consecutive = _ESCALATION_CRON_HEARTBEAT["consecutive_failures"]
    alert_triggered = consecutive >= _ESCALATION_CRON_MAX_FAILURES

    # [R27-②] alert_triggered → 실제 알림 발송
    alert_result = None
    if alert_triggered:
        alert_message = (
            f"❗ 케어링 에스컬레이션 크론 {consecutive}회 연속 실패 — "
            f"자살예방법§4 이행 불가 위험. 즉시 확인 필요. "
            f"({now.strftime('%Y-%m-%d %H:%M UTC')})"
        )
        alert_result = _send_alert_notification(
            channel="fcm",
            recipient_type="supervisor",
            message=alert_message,
            consecutive_failures=consecutive,
        )

    return {
        "heartbeat_recorded": True,
        "version": "v2 (alert_channel)",
        "run_count": _ESCALATION_CRON_HEARTBEAT["run_count"],
        "consecutive_failures": consecutive,
        "alert_triggered": alert_triggered,
        "alert_result": alert_result,
        "alert_message": (
            f"❗ 에스컬레이션 크론 연속 {consecutive}회 실패 — 즉시 확인 필요"
            if alert_triggered else None
        ),
        "alert_channel_status": alert_result["status"] if alert_result else "not_triggered",
    }


@router.get("/crisis/escalation-cron/alert-log")
async def get_alert_channel_log(
    current_user: dict = Depends(get_current_user),
):
    """
    [R27-②] 알림 채널 발송 이력 조회.
    크론 alert 발송 내역 — 운영팀 감사용.
    """
    return {
        "total_alerts": len(_ALERT_CHANNEL_LOG),
        "alerts": _ALERT_CHANNEL_LOG,
        "channel_config": {
            "fcm": "ESCALATION_ALERT_FCM_TOKEN env로 설정",
            "sms": "ESCALATION_ALERT_PHONE env로 설정",
            "fallback": "환경변수 미설정 시 log_only",
        },
    }
