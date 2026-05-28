"""
케어링 IVR 전화 발신 서비스
- 법적 포지션: 알림 서비스 (의료기기 아님)
- 복약 "관리" 표현 금지 → "알림/리마인더" 사용
"""
import os
import re
import urllib.parse

TWILIO_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_FROM = os.getenv("TWILIO_PHONE_NUMBER")  # 발신번호

# [MEDIUM FIX] 허용 도메인 화이트리스트 — SSRF 방어
_ALLOWED_CALLBACK_HOSTS = {
    os.getenv("API_BASE_HOST", "caring.example.com"),
    "localhost",
    "127.0.0.1",
}

_E164_PATTERN = re.compile(r"^\+[1-9]\d{7,14}$")


def _validate_phone_e164(phone: str) -> str:
    """
    [MEDIUM FIX] 전화번호 E.164 형식 검증
    잘못된 번호 Twilio 발신 차단
    """
    cleaned = re.sub(r"[\s\-\(\)]", "", phone)
    if not cleaned.startswith("+"):
        # 한국 번호 자동 변환 (+82)
        cleaned = "+82" + cleaned.lstrip("0")
    if not _E164_PATTERN.match(cleaned):
        raise ValueError(f"전화번호 형식 오류 (E.164 필수): {phone!r}")
    return cleaned


def _validate_callback_url(url: str) -> str:
    """
    [HIGH FIX] callback_url SSRF 방어 강화 — gstack /cso A08/A10
    - scheme 체크 먼저 (file:// javascript: 등 차단)
    - hostname whitelist 검증
    - path traversal 차단
    - production에서는 https 강제 (localhost 제외)
    """
    try:
        parsed = urllib.parse.urlparse(url)
        # 1. scheme 먼저 검증 (file://, javascript:, data:, ftp: 등 차단)
        if parsed.scheme not in ("https", "http"):
            raise ValueError(f"허용되지 않은 scheme: {parsed.scheme!r} (https/http만 허용)")
        # 2. hostname whitelist
        host = parsed.hostname or ""
        if host not in _ALLOWED_CALLBACK_HOSTS:
            raise ValueError(f"허용되지 않은 callback 도메인: {host!r}")
        # 3. production 환경에서 http → https 강제 (localhost 제외)
        is_local = host in ("localhost", "127.0.0.1")
        if not is_local and parsed.scheme == "http":
            raise ValueError("production callback_url은 https 필수")
        # 4. path traversal 차단
        if ".." in parsed.path:
            raise ValueError("callback_url path에 상위 경로 탐색 금지")
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"callback_url 검증 실패: {e}") from e
    return url


def build_reminder_twiml(med_name: str, child_callback_url: str) -> str:
    """
    복약 알림 TwiML 생성
    - "복약 관리" 금지 → "약 드실 시간" 표현 사용
    - 의료 행위 아님 고지 포함
    - [NOTICE 해소] med_name sanitize: Twilio SDK VoiceResponse.say()는 내부 XML escape
      처리하나, DB 저장값 신뢰성 확보를 위해 제어문자/특수문자 선제 제거
    """
    # [NOTICE 해소] med_name sanitize — 제어문자·XML 특수문자 제거 (Twilio SDK escape 보조)
    safe_med_name = re.sub(r"[<>&\"'\\\x00-\x1f]", "", med_name).strip()
    if not safe_med_name:
        safe_med_name = "약"  # 빈 문자열 폴백

    from twilio.twiml.voice_response import VoiceResponse, Gather  # lazy import
    response = VoiceResponse()

    # 인사 + 알림 (의료 지도 표현 금지)
    gather = Gather(num_digits=1, action=child_callback_url, timeout=10)
    gather.say(
        f"{safe_med_name} 드실 시간입니다. "
        "드셨으면 1번, 나중에 드실 예정이면 2번을 눌러주세요. "
        "저는 의료 전문가가 아닙니다. 건강 이상이 있으면 반드시 의사에게 상담하세요.",
        language="ko-KR",
    )
    response.append(gather)

    # 미응답 처리 → 자녀 알림 트리거
    response.say("응답이 없어 자녀분께 알림을 드립니다.", language="ko-KR")
    response.redirect(f"{child_callback_url}?no_response=true")

    return str(response)


def make_reminder_call(
    parent_phone: str,
    med_name: str,
    callback_url: str,
    retry_count: int = 0,
) -> dict:
    """
    부모님께 복약 알림 전화 발신
    - 재시도 최대 3회
    - 119 자동 연결 금지 (자녀 수동 판단)
    - Twilio 미설정 시 503 반환 (서버 기동에는 영향 없음)
    - [MEDIUM FIX] E.164 검증 + SSRF 방어
    """
    if retry_count >= 3:
        return {"status": "max_retry_reached", "action": "notify_child"}

    # [Twilio lazy-init 방어] 키 미설정 시 기능 비활성 (서버 기동에는 영향 없음)
    if not TWILIO_SID or not TWILIO_TOKEN or not TWILIO_FROM:
        return {
            "status": "twilio_not_configured",
            "message": "전화기능이 준비 중입니다. 관리자에게 문의하세요.",
        }

    # [MEDIUM FIX] 입력 검증
    try:
        safe_phone = _validate_phone_e164(parent_phone)
        safe_callback = _validate_callback_url(callback_url)
    except ValueError as e:
        return {"status": "invalid_input", "detail": str(e)}

    # [R22-H5] IVR kill-switch 확인
    if get_ivr_kill_switch():
        return {
            "status": "blocked",
            "reason": "IVR kill-switch 활성화 — 발신 차단됨",
            "action": "notify_child",
        }

    from twilio.rest import Client  # lazy import
    client = Client(TWILIO_SID, TWILIO_TOKEN)
    twiml = build_reminder_twiml(med_name, safe_callback)

    try:
        call = client.calls.create(
            twiml=twiml,
            to=safe_phone,
            from_=TWILIO_FROM,
        )
        return {
            "status": "initiated",
            "call_sid": call.sid,
            "retry_count": retry_count,
            "med_name": med_name,
        }
    except Exception as e:  # [GAP-SC1] Twilio 오류 → 자녀 앱 알림으로 폴백
        error_code = getattr(e, "code", None) or getattr(e, "status", "unknown")
        return {
            "status": "call_failed",
            "error_code": str(error_code),
            "error_message": str(e)[:200],
            "action": "notify_child",  # 호출자가 자녀 앱 푸시 알림 발송 처리
            "retry_count": retry_count,
            "med_name": med_name,
        }


# ─────────────────────────────────────────────────────────
# [R22-H5] IVR Kill-Switch — 긴급 발신 중단 스위치
# ─────────────────────────────────────────────────────────
import threading as _threading
_IVR_KILL_SWITCH = False
_IVR_KILL_LOCK = _threading.Lock()


def set_ivr_kill_switch(enabled: bool) -> dict:
    """
    IVR 발신 긴급 중단 스위치.
    enabled=True → 모든 발신 즉시 차단
    enabled=False → 발신 재개
    운영자 직접 호출 또는 Twilio 크레딧 임박 알람 연동 가능.
    """
    global _IVR_KILL_SWITCH
    with _IVR_KILL_LOCK:
        _IVR_KILL_SWITCH = enabled
    return {"kill_switch": enabled, "status": "updated"}


def get_ivr_kill_switch() -> bool:
    return _IVR_KILL_SWITCH


# ─────────────────────────────────────────────────────────
# [R23-H3] IVR 발신 결과 분기 처리
# ─────────────────────────────────────────────────────────
IVR_STATUS_ACTIONS = {
    "no-answer": {
        "retry_after_hours": 2,
        "max_retries": 3,
        "escalate_to": "child_push_notification",
        "reason": "부모님 전화 미수신 — 2시간 후 재시도, 최대 3회",
    },
    "busy": {
        "retry_after_minutes": 30,
        "max_retries": 5,
        "escalate_to": "sms_fallback",
        "reason": "통화 중 — 30분 후 재시도, 5회 후 SMS 전환",
    },
    "failed": {
        "retry_after_hours": 1,
        "max_retries": 2,
        "escalate_to": "child_app_alert",
        "reason": "통화 실패 — 1시간 후 재시도, 2회 후 자녀 앱 알림",
    },
    "completed": {
        "retry_after_hours": None,
        "max_retries": 0,
        "escalate_to": None,
        "reason": "통화 완료",
    },
}


def handle_ivr_status_callback(call_sid: str, call_status: str, retry_count: int = 0) -> dict:
    """
    [R23-H3] Twilio 상태 콜백 처리.
    call_status: "no-answer" | "busy" | "failed" | "completed" | "canceled"
    
    Returns: {"action": str, "should_retry": bool, "next_action": str}
    """
    status_lower = call_status.lower()
    config = IVR_STATUS_ACTIONS.get(status_lower, IVR_STATUS_ACTIONS["failed"])

    should_retry = (
        config["retry_after_hours"] is not None
        and retry_count < config["max_retries"]
    )
    escalate = not should_retry and config["escalate_to"] is not None

    return {
        "call_sid": call_sid,
        "status": status_lower,
        "should_retry": should_retry,
        "retry_count": retry_count,
        "max_retries": config["max_retries"],
        "next_retry_hours": config.get("retry_after_hours"),
        "next_retry_minutes": config.get("retry_after_minutes"),
        "escalate_to": config["escalate_to"] if escalate else None,
        "reason": config["reason"],
    }


# ─────────────────────────────────────────────────────────
# [R23-H4] 자녀 중복 발신 방지 — senior_id 기준 1일 1발신
# ─────────────────────────────────────────────────────────
import time as _ivr_time
import threading as _ivr_lock
from datetime import datetime, timezone, timedelta

_DAILY_CALL_LOG: dict = {}  # (child_id, senior_id) → last_called_date_kst (YYYY-MM-DD)
_DAILY_LIMIT_LOCK = _ivr_lock.Lock()
_KST = timezone(timedelta(hours=9))  # KST = UTC+9


def _kst_today() -> str:
    """현재 KST 날짜를 YYYY-MM-DD 형식으로 반환."""
    return datetime.now(_KST).strftime("%Y-%m-%d")


def _kst_midnight_tomorrow_iso() -> str:
    """내일 KST 자정 시각을 ISO 8601 UTC 형식으로 반환."""
    now_kst = datetime.now(_KST)
    tomorrow_midnight_kst = (now_kst + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    utc_dt = tomorrow_midnight_kst.astimezone(timezone.utc)
    return utc_dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def check_daily_limit(child_id: int, senior_id: int) -> dict:
    """
    [R23-H4] 자녀→부모님 발신 중복 방지.
    동일 (child_id, senior_id) 쌍으로 KST 기준 하루 1회 발신 제한.

    Rolling 24h 방식이 아닌 KST 자정 리셋 방식 사용:
    - 오전 11시 발신 → 당일 자정(00:00 KST) 리셋 후 재발신 가능
    - UTC 기준이면 KST와 9시간 오차 발생하므로 명시적 KST 변환

    Returns: {"allowed": bool, "next_allowed_at": str | None}
    """
    key = (child_id, senior_id)
    today_kst = _kst_today()

    with _DAILY_LIMIT_LOCK:
        last_date = _DAILY_CALL_LOG.get(key)
        if last_date == today_kst:
            next_at = _kst_midnight_tomorrow_iso()
            return {
                "allowed": False,
                "reason": "오늘 이미 발신했습니다. 내일 자정(KST) 이후 재발신 가능합니다.",
                "next_allowed_at": next_at,
            }

        # 발신 허용 → KST 날짜 기록
        _DAILY_CALL_LOG[key] = today_kst
        return {"allowed": True, "next_allowed_at": None}
