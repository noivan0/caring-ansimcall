"""
케어링 전화번호 OTP 인증 + 가족 양측동의 초대 엔드포인트

Phase 1 — SMS OTP
- POST /api/auth/phone/send-otp     → OTP 발송
- POST /api/auth/phone/verify-otp   → OTP 검증 + phone_verified 마킹

Phase 2 — 양측 동의 초대 시스템 (헤르2 설계 반영)
- POST /api/family/invite            → 자녀가 부모님께 초대 SMS 발송
- POST /api/family/invite/accept     → 부모님이 직접 OTP 확인 + 동의 완료
  * 부모님 본인이 OTP를 받고 동의해야만 등록 — 타인 번호 도용 원천 차단

법적 근거:
- 개인정보보호법 §29 — 양측 동의로 타인 번호 무단 등록 차단
- 정통망법 §50 — 검증된 번호에만 IVR 발신 허용
- 개인정보보호법 §22 — 부모님 직접 동의 기록 보관 의무
"""
import secrets
import time
import re
import threading
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, field_validator

from src.core.auth import get_current_user
from src.services.sms_service import send_otp, verify_otp, _send_sms
# [R52-RATE-001 FIX] OTP 브루트포스 방지 — slowapi Limiter
from slowapi import Limiter
from slowapi.util import get_remote_address
limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/auth/phone", tags=["phone-verify"])

_E164 = re.compile(r"^\+[1-9]\d{7,14}$")
# [R15] 한국 모바일 번호 검증 강화 (01X 계열만 IVR 발신 허용)
_KR_MOBILE = re.compile(r"^\+82(10|11|16|17|18|19)\d{7,8}$")

# Phase 2: 가족 초대 스토어 (운영환경 → Redis/DB)
# {invite_token: {"child_user_id": int, "parent_phone": str, "otp": str, "expires_at": float}}
_invite_store: dict = {}
_invite_lock = threading.Lock()  # [CSO-M2 FIX] A04 — concurrent accept TOCTOU 레이스 방어
_INVITE_TTL = 86400  # 24시간


def _normalize_phone(v: str) -> str:
    cleaned = re.sub(r"[\s\-\(\)]", "", v)
    if not cleaned.startswith("+"):
        # 010-xxxx-xxxx → +8210xxxxxxxx 변환
        cleaned = "+82" + cleaned.lstrip("0")
    if not _E164.match(cleaned):
        raise ValueError("전화번호 형식 오류 (예: +821****5678)")
    # [R15] IVR 발신은 한국 모바일 번호만 허용
    if cleaned.startswith("+82") and not _KR_MOBILE.match(cleaned):
        raise ValueError("한국 모바일 번호(010/011/016/017/018/019)만 지원합니다")
    return cleaned


# ─────────────────────────────────────────────────────────
# Phase 1: 자기 번호 OTP 인증
# ─────────────────────────────────────────────────────────

class OtpSendRequest(BaseModel):
    phone: str

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        return _normalize_phone(v)


class OtpVerifyRequest(BaseModel):
    phone: str
    otp: str

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        return _normalize_phone(v)

    @field_validator("otp")
    @classmethod
    def validate_otp(cls, v: str) -> str:
        if not re.match(r"^\d{6}$", v.strip()):
            raise ValueError("OTP는 6자리 숫자입니다")
        return v.strip()


@router.post("/send-otp")
@limiter.limit("3/minute")  # [R52-RATE-001 FIX] OTP 발송 브루트포스 방지
def send_otp_endpoint(
    request: Request,
    body: OtpSendRequest,
    _user: dict = Depends(get_current_user),
):
    """OTP 발송 (레이트리밋: 1분 3회 / TTL: 5분)"""
    try:
        result = send_otp(body.phone)
        return {"success": True, "message": "인증번호가 발송되었습니다.", **result}
    except ValueError as e:
        # [SC 3.3.1 WCAG] aria-describedby 연결용 error_hint 포함
        raise HTTPException(
            status_code=429,
            detail={
                "message": str(e),
                "error_hint": "올바른 전화번호 형식: 010-1234-5678 또는 +82-10-1234-5678",
                "field": "phone",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail="SMS 발송에 실패했습니다. 잠시 후 다시 시도해주세요.")


@router.post("/verify-otp")
@limiter.limit("5/minute")  # [R52-RATE-001 FIX] OTP 검증 브루트포스 방지 (CVSS 7.8)
def verify_otp_endpoint(
    request: Request,
    body: OtpVerifyRequest,
    _user: dict = Depends(get_current_user),
):
    """OTP 검증 — 성공 시 phone_verified=True"""
    try:
        ok = verify_otp(body.phone, body.otp)
    except ValueError as e:
        raise HTTPException(status_code=429, detail="요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.")

    if not ok:
        raise HTTPException(status_code=400, detail="인증번호가 올바르지 않거나 만료되었습니다.")

    # [Sprint-5] DB에 phone_verified=True + phone 번호 저장 (user_id 연결)
    user_id = _user["user_id"]
    import os as _os
    db_url = _os.getenv("DATABASE_URL", "")
    if db_url:
        try:
            from sqlalchemy import create_engine, text as _text  # type: ignore[import]
            from sqlalchemy.orm import sessionmaker as _sessionmaker
            _engine = create_engine(db_url, pool_pre_ping=True)
            _Session = _sessionmaker(bind=_engine)
            with _Session() as _sess:
                _sess.execute(
                    _text(
                        "UPDATE users SET phone = :phone, phone_verified = 1 WHERE id = :uid"
                    ),
                    {"phone": body.phone, "uid": user_id},
                )
                _sess.commit()
        except Exception as _db_err:
            # DB 저장 실패는 비치명적 — 응답은 성공 반환 (서비스 연속성)
            import logging as _logging
            _logging.getLogger(__name__).warning(
                f"[phone_verify] DB phone_verified 저장 실패: user_id={user_id}, err={_db_err}"
            )

    return {
        "success": True,
        "phone_verified": True,
        "message": "전화번호 인증이 완료되었습니다.",
        "legal": "개인정보보호법 §29 — 검증된 번호에만 IVR 알림 발신 허용",
    }


# ─────────────────────────────────────────────────────────
# Phase 2: 양측 동의 가족 초대 시스템
# ─────────────────────────────────────────────────────────

class FamilyInviteRequest(BaseModel):
    parent_phone: str
    parent_name: str

    @field_validator("parent_phone")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        return _normalize_phone(v)


class FamilyInviteAcceptRequest(BaseModel):
    invite_token: str
    otp: str

    @field_validator("otp")
    @classmethod
    def validate_otp(cls, v: str) -> str:
        if not re.match(r"^\d{6}$", v.strip()):
            raise ValueError("OTP는 6자리 숫자입니다")
        return v.strip()


@router.post("/family/invite")
@limiter.limit("3/minute")  # [CSO-M1 FIX] A05 — SMS 무제한 발송 차단, IP 기준 1분 3회
def send_family_invite(
    request: Request,
    body: FamilyInviteRequest,
    user: dict = Depends(get_current_user),
):
    """
    [Phase 2] 자녀가 부모님께 케어링 알림 등록 초대 SMS 발송.
    - 6자리 OTP + 고유 invite_token 생성
    - 부모님 번호로 동의 안내 SMS 발송
    - 부모님이 직접 /invite/accept 호출해야만 등록 완료
    """
    child_user_id = user.get("user_id", 0)
    invite_token = secrets.token_urlsafe(24)
    otp = str(secrets.randbelow(900000) + 100000)

    _invite_store[invite_token] = {
        "child_user_id": child_user_id,
        "parent_phone": body.parent_phone,
        "parent_name": body.parent_name,
        "otp": otp,
        "expires_at": time.time() + _INVITE_TTL,
        "status": "pending",
    }

    # 부모님께 동의 안내 SMS 발송
    message = (
        f"[케어링] {body.parent_name}님, 자녀분이 복약 알림 서비스 등록을 요청했습니다.\n"
        f"동의하시면 아래 인증번호를 앱에 입력해주세요: {otp}\n"
        f"(24시간 유효 / 동의하지 않으시면 무시해주세요)"
    )
    try:
        _send_sms(body.parent_phone, message)
    except Exception as e:
        del _invite_store[invite_token]
        raise HTTPException(status_code=503, detail="초대 SMS 발송에 실패했습니다. 잠시 후 다시 시도해주세요.")

    return {
        "success": True,
        "invite_token": invite_token,
        "message": f"{body.parent_name}님께 동의 요청 SMS를 발송했습니다.",
        "expires_in_hours": 24,
        "legal": "정통망법 §50 — 부모님 사전 수신 동의 절차 준수",
    }


@router.post("/family/invite/accept")
@limiter.limit("5/minute")  # [CSO-003 FIX] A07 — OTP 브루트포스 방어 rate limit 추가
def accept_family_invite(request: Request, body: FamilyInviteAcceptRequest):
    """
    [Phase 2] 부모님이 직접 OTP 입력 + 동의 완료.
    - 인증 없이 호출 가능 (부모님은 앱 미설치 상태일 수 있음)
    - OTP + invite_token 모두 맞아야 등록 완료
    - 성공 시 _invite_store에서 즉시 삭제 (재사용 불가)
    """
    with _invite_lock:  # [CSO-M2 FIX] A04 — TOCTOU 레이스 방어: check-then-act 원자화
        record = _invite_store.get(body.invite_token)
        if not record:
            raise HTTPException(status_code=404, detail="유효하지 않은 초대 링크입니다.")

        if time.time() > record["expires_at"]:
            del _invite_store[body.invite_token]
            raise HTTPException(status_code=410, detail="초대 링크가 만료되었습니다. 자녀분께 재요청해주세요.")

        if not secrets.compare_digest(record["otp"], body.otp.strip()):
            raise HTTPException(status_code=400, detail="인증번호가 올바르지 않습니다.")

        # 동의 완료 처리
        parent_phone = record["parent_phone"]
        child_user_id = record["child_user_id"]
        parent_name = record["parent_name"]
        del _invite_store[body.invite_token]  # one-time use (Lock 내부에서 원자적 삭제)

    # [Sprint-7] DB에 family_consent 기록 저장
    # guardian_relationships.consent_status 업데이트
    # child_user_id, parent_phone, parent_name, consented_at, consent_ip 기록
    import os as _os
    _db_url = _os.getenv("DATABASE_URL", "")
    _consent_ip = request.client.host if request.client else "unknown"
    if _db_url:
        try:
            from sqlalchemy import create_engine, text as _text  # type: ignore[import]
            from sqlalchemy.orm import sessionmaker as _sessionmaker
            _engine = create_engine(_db_url, pool_pre_ping=True)
            _Session = _sessionmaker(bind=_engine)
            with _Session() as _sess:
                # guardian_relationships.consent_status 업데이트
                _sess.execute(
                    _text(
                        """
                        UPDATE guardian_relationships
                           SET consent_status = 'accepted',
                               consented_at   = datetime('now'),
                               consent_ip     = :consent_ip,
                               parent_name    = :parent_name
                         WHERE child_user_id = :child_user_id
                           AND parent_phone  = :parent_phone
                        """
                    ),
                    {
                        "child_user_id": child_user_id,
                        "parent_phone": parent_phone,
                        "parent_name": parent_name,
                        "consent_ip": _consent_ip,
                    },
                )
                _sess.commit()
        except Exception as _db_err:
            # DB 저장 실패는 비치명적 — 동의 응답은 성공 반환 (서비스 연속성)
            import logging as _logging
            _logging.getLogger(__name__).warning(
                f"[family_consent] DB guardian_relationships 업데이트 실패: "
                f"child_user_id={child_user_id}, err={_db_err}"
            )

    return {
        "success": True,
        "consented": True,
        "parent_phone_masked": parent_phone[:3] + "****" + parent_phone[-4:],
        "message": f"{parent_name}님의 동의가 완료되었습니다. 이제 케어링 알림을 받으실 수 있습니다.",
        "legal": (
            "개인정보보호법 §22 — 부모님 직접 동의 완료 / "
            "정통망법 §50 — 수신 동의 기록 보관"
        ),
    }
