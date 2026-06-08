"""
인증 유틸리티 — 완전판
[CVE-2024-33664] python-jose → PyJWT==2.9.0
[CVE-2024-0232] bcrypt==4.2.0 72바이트 명시 절단
"""
import os
import jwt
import bcrypt
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from src.core.env import load_project_env

load_project_env()

SECRET_KEY = os.environ["SECRET_KEY"]
REFRESH_SECRET_KEY = os.environ["REFRESH_SECRET_KEY"]  # 기본값 없음 — 미설정 시 서버 시작 실패 (명시적 오류가 silent 취약보다 낫다)
ALGORITHM = "HS256"
ACCESS_EXPIRE_MINUTES = 60 * 24       # 24h
REFRESH_EXPIRE_DAYS = 30              # 30일
SSE_EXPIRE_MINUTES = 30              # [R26-①] SSE 전용 토큰 30분

security = HTTPBearer()


def hash_password(password: str) -> str:
    """
    [CVE-2024-0232] 72바이트 명시 절단 후 bcrypt
    """
    pwd_bytes = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    """
    [MEDIUM 확인] bcrypt.checkpw() 내부적으로 timing-safe 비교 수행
    — hmac.compare_digest() 별도 추가 불필요
    """
    pwd_bytes = plain.encode("utf-8")[:72]
    return bcrypt.checkpw(pwd_bytes, hashed.encode())


def create_access_token(user_id: int, extra: dict | None = None) -> str:
    """
    [CVE-2024-33664] 알고리즘 명시 + exp/sub 강제
    """
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_EXPIRE_MINUTES),
        "iat": datetime.now(timezone.utc),
        "type": "access",
        **(extra or {}),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def create_sse_token(user_id: int) -> str:
    """
    [R26-①] SSE 전용 단기 토큰 (30분).

    일반 access_token(24h)과 scope 분리:
    - type: "sse_access" — /ai/stream 전용
    - 만료 30분 — 일반 API 토큰보다 짧음 (최소권한 원칙)
    - 동일 SECRET_KEY 사용 (별도 시크릿으로 강화 가능)

    SSE 연결 수명(통상 수 초~수 분)보다 충분히 길고,
    일반 API 토큰보다 짧은 최소권한 설계.
    """
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=SSE_EXPIRE_MINUTES),
        "iat": datetime.now(timezone.utc),
        "type": "sse_access",   # SSE 전용 type — 일반 API 접근 불가
        "scope": "sse:read",    # 명시적 scope 제한
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)



def create_refresh_token(user_id: int) -> str:
    """Refresh token — 30일, 별도 시크릿"""
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(days=REFRESH_EXPIRE_DAYS),
        "iat": datetime.now(timezone.utc),
        "type": "refresh",
    }
    return jwt.encode(payload, REFRESH_SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str, is_refresh: bool = False) -> dict:
    """
    알고리즘 명시 → alg:none 차단
    exp + sub 강제 검증
    """
    key = REFRESH_SECRET_KEY if is_refresh else SECRET_KEY
    return jwt.decode(
        token,
        key,
        algorithms=[ALGORITHM],          # 명시적 허용만
        options={"require": ["exp", "sub"]},
    )


# ─── [R70-RT-001] Refresh Token JTI 블랙리스트 ──────────────────────
# [A07-REVOKE] 탈퇴/로그아웃 시 JWT 블랙리스트 — RT 재사용 공격 방어
from datetime import datetime as _dt_cls

_revoked_tokens: dict = {}   # jti → expiry_ts
_revoked_users: dict = {}    # user_id → revoked_before_ts


def revoke_token(jti: str, expiry: float) -> None:
    """사용된 Refresh Token jti를 블랙리스트에 등록."""
    now = _dt_cls.now(timezone.utc).timestamp()
    if expiry > now:
        _revoked_tokens[jti] = expiry


def revoke_user_tokens(user_id: int) -> None:
    """탈퇴/로그아웃 시 해당 user의 모든 기존 토큰 무효화."""
    _revoked_users[str(user_id)] = _dt_cls.now(timezone.utc).timestamp()


def is_token_revoked(jti: str, user_id: str, iat: float) -> bool:
    """jti 단위 및 user 단위 폐기 여부 검사."""
    now = _dt_cls.now(timezone.utc).timestamp()
    # jti 블랙리스트 확인
    if jti in _revoked_tokens:
        if now < _revoked_tokens[jti]:
            return True
    # user 단위 폐기 확인 (iat < revoked_before_ts)
    revoked_at = _revoked_users.get(user_id)
    if revoked_at and iat < revoked_at:
        return True
    return False


def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """
    FastAPI 의존성 주입 — 모든 보호 라우터에 Depends(get_current_user)
    """
    try:
        payload = decode_token(creds.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="refresh token은 API 접근 불가")
        return {"user_id": int(payload["sub"]), "payload": payload}
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="토큰 만료 — 재로그인 필요",
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 토큰",
        )
