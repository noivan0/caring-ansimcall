"""
케어링 SMS 발송 서비스
- OTP 인증: 부모님 전화번호 본인 확인
- 알리고 API 사용 (Twilio SMS보다 저렴, ₩9/건)
- Twilio 폴백 지원
"""
import os
import re
import secrets
import hashlib
import time
import threading
from datetime import datetime, timezone
from src.core.env import load_project_env

load_project_env()

TWILIO_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_FROM = os.getenv("TWILIO_PHONE_NUMBER")

_E164_PATTERN = re.compile(r"^\+[1-9]\d{7,14}$")

# 인메모리 OTP 스토어 (운영 환경에서는 Redis로 교체)
# {phone_hash: {"otp": str, "expires_at": float, "attempts": int}}
_otp_store: dict = {}
_OTP_TTL = 300        # 5분
_MAX_ATTEMPTS = 5     # 최대 5회 시도
_RATE_LIMIT_WINDOW = 60  # 1분
_otp_send_log: dict = {}  # {phone_hash: [timestamp, ...]}
_otp_lock = threading.Lock()  # [②-A] OTP store 원자성 보장


def _hash_phone(phone: str) -> str:
    """전화번호 해시 (저장 시 원문 노출 방지)"""
    return hashlib.sha256(phone.encode()).hexdigest()[:16]


def _normalize_phone(phone: str) -> str:
    """E.164 정규화"""
    cleaned = re.sub(r"[\s\-\(\)]", "", phone)
    if not cleaned.startswith("+"):
        cleaned = "+82" + cleaned.lstrip("0")
    if not _E164_PATTERN.match(cleaned):
        raise ValueError(f"전화번호 형식 오류 (E.164 필수): {phone!r}")
    return cleaned


def _check_rate_limit(phone_hash: str) -> None:
    """분당 3회 초과 발송 차단 (브루트포스 방지)"""
    now = time.time()
    log = _otp_send_log.get(phone_hash, [])
    # 1분 이내 기록만 유지
    log = [t for t in log if now - t < _RATE_LIMIT_WINDOW]
    if len(log) >= 3:
        raise ValueError("OTP 발송 횟수 초과 (1분에 최대 3회). 잠시 후 다시 시도해주세요.")
    log.append(now)
    _otp_send_log[phone_hash] = log


def send_otp(phone: str) -> dict:
    """
    OTP 발송
    - E.164 정규화
    - 레이트리밋 확인
    - 6자리 OTP 생성 (암호학적 안전난수)
    - SMS 발송 (Twilio)
    - TTL 5분으로 스토어 저장
    """
    phone = _normalize_phone(phone)
    phone_hash = _hash_phone(phone)

    _check_rate_limit(phone_hash)

    otp = str(secrets.randbelow(900000) + 100000)  # 100000~999999
    expires_at = time.time() + _OTP_TTL

    _otp_store[phone_hash] = {
        "otp": otp,
        "expires_at": expires_at,
        "attempts": 0,
    }

    _send_sms(phone, f"[케어링] 인증번호: {otp} (5분 이내 입력)")

    return {
        "sent": True,
        "phone_masked": phone[:3] + "****" + phone[-4:] if len(phone) > 7 else "****",
        "expires_in": _OTP_TTL,
    }


def verify_otp(phone: str, otp: str) -> bool:
    """
    OTP 검증
    - 만료 확인
    - 최대 시도 횟수 확인
    - 정시간 비교 (타이밍 어택 방지 — secrets.compare_digest)
    - 검증 성공 시 즉시 삭제 (재사용 불가)
    """
    phone = _normalize_phone(phone)
    phone_hash = _hash_phone(phone)

    with _otp_lock:  # [②-A] 원자성 보장 (GETDEL 패턴)
        record = _otp_store.get(phone_hash)
        if not record:
            return False

        if time.time() > record["expires_at"]:
            del _otp_store[phone_hash]
            return False

        if record["attempts"] >= _MAX_ATTEMPTS:
            del _otp_store[phone_hash]
            raise ValueError("OTP 시도 횟수 초과. 재발송해주세요.")

        record["attempts"] += 1

        if not secrets.compare_digest(record["otp"], otp.strip()):
            return False

        # 검증 성공 — 즉시 삭제 (one-time use)
        del _otp_store[phone_hash]
        return True


def _send_sms(phone: str, message: str) -> None:
    """
    Twilio SMS 발송
    운영: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER 환경변수 필요
    """
    if not TWILIO_SID or not TWILIO_TOKEN or not TWILIO_FROM:
        # 개발/테스트 환경: 발송 시뮬레이션
        import logging
        logging.getLogger(__name__).info(
            f"[SMS MOCK] to={phone} msg={message}"
        )
        return

    try:
        import requests
        resp = requests.post(
            f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json",
            auth=(TWILIO_SID, TWILIO_TOKEN),
            data={"From": TWILIO_FROM, "To": phone, "Body": message},
            timeout=10,
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Twilio 발송 실패 ({resp.status_code}): {resp.text[:200]}")
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"[SMS] 발송 오류: {e}")
        raise
