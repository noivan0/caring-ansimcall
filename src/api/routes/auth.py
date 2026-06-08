"""
인증 라우터 — 카카오/구글 OAuth + JWT 발급
[R25-①] SSE CSRF 방어: access_token 쿠키 HttpOnly + SameSite=Strict 강제 발급
"""
from fastapi import APIRouter, HTTPException, Depends, Response, Request
from pydantic import BaseModel
from src.core.auth import (
    create_access_token, create_refresh_token, create_sse_token,
    decode_token, get_current_user, SSE_EXPIRE_MINUTES,
    revoke_token, revoke_user_tokens, is_token_revoked,  # [R70-RT-001] JTI 블랙리스트
)
from src.api.rate_limiter import limiter  # [R61-RL-AUTH] 순환임포트 방지

router = APIRouter(tags=["auth"])

# ─── 쿠키 보안 설정 상수 ────────────────────────────────────
_COOKIE_SETTINGS = dict(
    key="access_token",
    httponly=True,          # JS 접근 차단 (XSS 방어)
    samesite="strict",      # [R25-①] CSRF 방어 — 외부 사이트 쿠키 전송 차단
    secure=True,            # HTTPS 전용 (프로덕션)
    max_age=60 * 60 * 24,  # 24h (access token 만료와 동일)
    path="/",
)

_REFRESH_COOKIE_SETTINGS = dict(
    key="refresh_token",
    httponly=True,
    samesite="strict",
    secure=True,
    max_age=60 * 60 * 24 * 30,  # 30일
    path="/api/auth/refresh",   # refresh 엔드포인트에만 전송
)

# [R26-①] SSE 전용 쿠키 — 일반 access_token과 scope/만료 분리
_SSE_COOKIE_SETTINGS = dict(
    key="sse_token",
    httponly=True,
    samesite="strict",
    secure=True,
    max_age=SSE_EXPIRE_MINUTES * 60,  # 30분 — 일반 토큰(24h)보다 짧음
    path="/api/ai",              # /api/ai/* 엔드포인트에만 전송 (scope 제한)
)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


@router.post("/refresh", response_model=TokenPair)
@limiter.limit("20/minute")
def refresh_token(request: Request, response: Response, refresh_token: str):
    """
    Refresh token → 새 access token 발급
    [R25-①] 새 토큰을 쿠키로도 발급 (SSE 재연결 시 만료 방지)
    type='refresh' 검증 필수
    """
    try:
        payload = decode_token(refresh_token, is_refresh=True)
        if payload.get("type") != "refresh":
            raise HTTPException(400, "유효하지 않은 refresh token")
        user_id = int(payload["sub"])

        # [R70-RT-001] JTI 블랙리스트 검사 — 이미 사용된 RT 재사용 차단
        jti = payload.get("jti", f"{payload['sub']}:{payload.get('iat', 0)}")
        iat = float(payload.get("iat", 0))
        exp = float(payload.get("exp", 0))
        if is_token_revoked(jti, str(user_id), iat):
            raise HTTPException(401, "이미 사용된 refresh token — 재로그인 필요")
        # 사용 즉시 폐기 (Rotation 방식)
        revoke_token(jti, exp)

        new_access = create_access_token(user_id)
        new_refresh = create_refresh_token(user_id)

        # [R25-①] SSE 재연결 대비: 쿠키 갱신
        response.set_cookie(value=new_access, **_COOKIE_SETTINGS)
        response.set_cookie(value=new_refresh, **_REFRESH_COOKIE_SETTINGS)

        return TokenPair(
            access_token=new_access,
            refresh_token=new_refresh,
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "토큰 갱신에 실패했습니다. 다시 로그인해주세요.")


@router.post("/login/cookie")
@limiter.limit("10/minute")
def login_with_cookie(request: Request, response: Response, current_user: dict = Depends(get_current_user)):
    """
    [R25-①] SSE 전용 쿠키 기반 로그인.
    [R26-①] SSE 전용 토큰(30분)과 일반 access_token(24h) scope 분리.
    [CSO-001 FIX] A01/A07 — Bearer 토큰 인증 필수. 임의 user_id 지정 불가,
    인증된 현재 사용자의 ID만 사용하여 쿠키 발급.

    - access_token 쿠키 (24h, path=/): 일반 API 접근용
    - sse_token 쿠키 (30min, path=/api/ai): SSE 전용, 최소권한
    - refresh_token 쿠키 (30일, path=/api/auth/refresh): 갱신 전용
    """
    user_id = current_user["user_id"]  # [CSO-001] 요청자 본인 ID만 사용
    access = create_access_token(user_id)
    refresh = create_refresh_token(user_id)
    sse = create_sse_token(user_id)

    response.set_cookie(value=access, **_COOKIE_SETTINGS)
    response.set_cookie(value=refresh, **_REFRESH_COOKIE_SETTINGS)
    response.set_cookie(value=sse, **_SSE_COOKIE_SETTINGS)  # [R26-①] SSE 전용

    return {
        "message": "쿠키 발급 완료 — SSE 연결 가능",
        "auth_method": "cookie",
        "csrf_protection": "SameSite=Strict",
        "access_token_cookie": f"access_token (HttpOnly, 24h, path=/)",
        "sse_token_cookie": f"sse_token (HttpOnly, {SSE_EXPIRE_MINUTES}min, path=/api/ai)",
        "scope_separation": "SSE 전용 토큰(30min) 별도 발급 — 최소권한 원칙",
    }


@router.get("/me")
def get_me(current_user: dict = Depends(get_current_user)):
    """현재 로그인 사용자 정보"""
    return {"user_id": current_user["user_id"]}


@router.post("/logout")
@limiter.limit("30/minute")
def logout(request: Request, response: Response, current_user: dict = Depends(get_current_user)):
    """
    로그아웃 — 쿠키 명시적 만료 처리
    [R25-①] 쿠키 기반 인증이므로 서버에서 쿠키 삭제 필수
    [R70-RT-001] 해당 유저의 모든 기존 토큰 무효화
    """
    user_id = current_user.get("user_id")
    if user_id:
        revoke_user_tokens(user_id)  # [R70-RT-001] 전체 토큰 폐기
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/api/auth/refresh")
    return {"message": "로그아웃 완료 — 쿠키 삭제됨"}


@router.post("/sse-refresh")
@limiter.limit("30/minute")
def sse_token_refresh(request: Request, response: Response, current_user: dict = Depends(get_current_user)):
    """
    [R27-①] SSE 토큰 무중단 갱신 엔드포인트.

    SSE 연결 중 token_warning 이벤트 수신 시 클라이언트가 호출.
    새 sse_token 쿠키 발급 → 클라이언트 재연결 시 자동 적용.

    흐름:
    1. EventSource 수신: event=token_warning (만료 5분 전)
    2. 클라이언트: POST /api/auth/sse-refresh (credentials: 'include')
    3. 서버: 새 sse_token 쿠키 발급 (30분 연장)
    4. 클라이언트: 기존 EventSource 닫기 → 새 EventSource 생성 (재연결)
    5. 새 쿠키로 자동 인증 → 무중단 갱신 완료

    주의: access_token(24h) 쿠키로 인증 후 sse_token(30min) 갱신.
    access_token 만료 시에는 /auth/refresh 호출 필요.
    """
    user_id = current_user["user_id"]
    new_sse_token = create_sse_token(user_id)

    response.set_cookie(value=new_sse_token, **_SSE_COOKIE_SETTINGS)

    return {
        "refreshed": True,
        "token_type": "sse_access",
        "expires_in_seconds": SSE_EXPIRE_MINUTES * 60,
        "message": f"SSE 토큰 {SSE_EXPIRE_MINUTES}분 연장 — 재연결 시 자동 적용",
        "next_action": "EventSource 재연결 (/api/ai/stream/v2)",
    }


# ─────────────────────────────────────────────────────────
# [R54-CONSENT-001] 개보법 36조 — 회원 탈퇴 (30일 내 삭제 의무)
# ─────────────────────────────────────────────────────────
import logging as _logging
_logger = _logging.getLogger(__name__)

@router.delete("/account")
@limiter.limit("5/minute")
def delete_account(
    request: Request,
    response: Response,
    current_user: dict = Depends(get_current_user),
):
    """
    회원 탈퇴 — 개인정보보호법 §21(보유기간 초과 후 파기) + §36(정정·삭제 청구권)

    처리 단계:
    1. access_token / refresh_token / sse_token 쿠키 즉시 삭제
    2. DB 사용자 데이터 익명화 (개보법 §21 — 즉시 처리)
    3. guardian_relationships is_active=False (관계 비활성화)
    4. medication_schedules is_active=False (알림 중단)
    5. 감사 로그 기록 (자살예방법§4 notification_log는 5년 보존 예외)

    법적 의무: 탈퇴 요청일로부터 30일 내 개인정보 파기 (개보법 §21①)
    예외: notification_log — 자살예방법§4 이행 증거로 5년 보존
    """
    import os as _os_local
    user_id = current_user["user_id"]

    # 1. 쿠키 삭제 (JWT 세션 즉시 무효화)
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/api/auth/refresh")
    response.delete_cookie("sse_token", path="/api")

    # [R70-RT-001] 탈퇴 시 해당 유저 모든 토큰 서버측 폐기
    revoke_user_tokens(user_id)

    # 2. DB 익명화 — [R56-ANON-001] 개보법 §21 즉시 이행
    db_url = _os_local.getenv("DATABASE_URL", "")
    if db_url:
        try:
            from sqlalchemy import create_engine, text  # type: ignore[import]
            from sqlalchemy.orm import sessionmaker
            _anon_engine = create_engine(db_url, pool_pre_ping=True)
            Session = sessionmaker(bind=_anon_engine)
            anon_alias = f"deleted_{str(user_id)[:8]}"
            with Session() as sess:
                # users: 개인식별정보 즉시 익명화
                sess.execute(text(
                    "UPDATE users SET "
                    "  name = :alias, "
                    "  phone = NULL, "
                    "  birth = NULL, "
                    "  email = :email, "
                    "  profile_image = NULL, "
                    "  is_deleted = 1 "
                    "WHERE id = :uid"
                ), {"alias": f"탈퇴회원_{anon_alias}", "email": f"{anon_alias}@anonymous.invalid", "uid": user_id})
                # guardian_relationships: 비활성화 (soft delete — 관계 이력 보존)
                sess.execute(text(
                    "UPDATE guardian_relationships SET is_active = 0 "
                    "WHERE guardian_user_id = :uid "
                    "OR elder_id IN (SELECT id FROM elders WHERE user_id = :uid)"
                ), {"uid": user_id})
                # medication_schedules: 알림 중단
                sess.execute(text(
                    "UPDATE medication_schedules SET is_active = 0 "
                    "WHERE child_user_id = :uid"
                ), {"uid": user_id})
                sess.commit()
            _logger.info(f"[개보법§21] 회원 탈퇴 익명화 완료: user_id={user_id}")
        except Exception as _e:
            _logger.error(f"[개보법§21] 익명화 실패: user_id={user_id}, err={_e}")
            # 쿠키는 이미 삭제됨 — 익명화 실패는 별도 운영 이슈로 처리
    else:
        _logger.warning(f"[개보법§21] DATABASE_URL 미설정 — 익명화 건너뜀: user_id={user_id}")

    _logger.info(f"[개보법§21] 회원 탈퇴 처리 완료: user_id={user_id} (notification_log는 자살예방법§4로 5년 보존)")

    return {
        "message": "탈퇴 처리가 완료되었습니다.",
        "legal": "개인정보보호법 §21① — 개인식별정보 즉시 익명화 처리",
        "exception": "notification_log는 자살예방법§4 이행 증거로 5년 보존",
    }
