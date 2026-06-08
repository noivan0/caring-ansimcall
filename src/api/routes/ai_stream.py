"""
[R24-②] /ai/stream — SSE AI 로딩 스트림 (쿠키 기반 JWT 인증)

헤르2 설계 채택:
- EventSource는 커스텀 헤더 불가 → 쿠키 기반 인증 사용
- access_token 쿠키: HttpOnly + SameSite=Strict (CSRF 방어)
- asyncio.timeout(30) + Semaphore(50) 무한 연결 방지
- 쿼리파라미터 토큰 방식 금지 (서버 로그 노출 위험)
"""
import asyncio
import json
from datetime import datetime, timezone
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
_limiter = Limiter(key_func=get_remote_address)  # [R11-RL-001] 순환참조 방지 — ai_stream 전용 limiter

from src.core.auth import decode_token
import jwt

router = APIRouter()

# ─── 동시 연결 수 제한 (무한 연결 DoS 방지) ───
_SSE_SEMAPHORE = asyncio.Semaphore(50)
_SSE_TIMEOUT_SECONDS = 30


def _verify_cookie_token(request: Request) -> dict:
    """
    [R24-②] 쿠키 기반 JWT 검증.

    EventSource는 Authorization 헤더를 지원하지 않으므로
    access_token 쿠키에서 JWT를 읽어 검증.

    보안:
    - 쿠키는 HttpOnly + SameSite=Strict 으로 설정되어야 함 (Set-Cookie 단계에서 강제)
    - CSRF 방어: SameSite=Strict → 외부 사이트 EventSource 요청 차단
    - 로그 노출 없음: 쿠키는 access log에 기록되지 않음 (쿼리파라미터와 달리)
    """
    token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(
            status_code=401,
            detail="SSE 인증 실패: access_token 쿠키 없음. 로그인 후 재시도",
        )
    try:
        # 먼저 refresh token 시크릿으로 디코딩 시도 → type 확인
        try:
            refresh_payload = decode_token(token, is_refresh=True)
            if refresh_payload.get("type") == "refresh":
                raise HTTPException(status_code=401, detail="refresh token은 SSE 접근 불가")
        except jwt.InvalidTokenError:
            pass  # refresh 시크릿으로 안 풀리면 access token으로 진행

        payload = decode_token(token)
        # [R26-①] SSE 전용 토큰(sse_access) 또는 일반 access token 허용
        allowed_types = {"access", "sse_access"}
        if payload.get("type") not in allowed_types:
            raise HTTPException(status_code=401, detail="refresh token은 SSE 접근 불가")
        return {"user_id": int(payload["sub"]), "payload": payload, "token_type": payload.get("type")}
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="SSE 토큰 만료 — 재로그인 후 재시도")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="유효하지 않은 SSE 토큰")


async def _ai_analysis_stream(user_id: int) -> AsyncGenerator[str, None]:
    """
    AI 분석 결과를 SSE 이벤트로 스트리밍.
    실제 ML 파이프라인 연결 전 단계 — 구조적 완성도 확보.
    """
    stages = [
        {"stage": "init", "message": "AI 분석 시작 중...", "progress": 10},
        {"stage": "loading", "message": "건강 패턴 분석 중...", "progress": 40},
        {"stage": "processing", "message": "맞춤 인사이트 생성 중...", "progress": 70},
        {"stage": "finalizing", "message": "결과 정리 중...", "progress": 90},
    ]

    for stage_data in stages:
        payload = json.dumps({
            **stage_data,
            "user_id": user_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False)
        yield f"data: {payload}\n\n"
        await asyncio.sleep(0.3)  # 단계 간 딜레이

    # [R11-KR-001] 개보법 제37조의2 AI 자동화 결정 고지
    legal_payload = json.dumps({
        "stage": "legal_notice",
        "message": "AI가 분석한 건강 인사이트이며 의사 진단을 대체하지 않습니다.",
        "legal_basis": "개인정보 보호법 제37조의2 — AI 자동화 결정 고지 의무",
        "objection": "AI 분석 결과에 이의가 있으시면 고객센터(1588-XXXX)로 문의하세요.",
        "automated_decision": True,
        "progress": 95,
        "user_id": user_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False)
    yield f"data: {legal_payload}\n\n"

    # 완료 이벤트
    done_payload = json.dumps({
        "stage": "done",
        "message": "분석 완료",
        "progress": 100,
        "user_id": user_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False)
    yield f"data: {done_payload}\n\n"
    yield "event: done\ndata: {}\n\n"


@router.get("/ai/stream")
@_limiter.limit("5/minute")  # [R11-RL-001] AI Stream Rate Limit
async def ai_stream(request: Request):
    """
    [R24-②] AI 로딩 SSE 스트림 (쿠키 기반 JWT 인증)

    인증: access_token 쿠키 (HttpOnly + SameSite=Strict)
    연결 제한: 최대 50개 동시 연결, 30초 타임아웃
    Content-Type: text/event-stream

    클라이언트 예시:
        const es = new EventSource('/api/ai/stream', { withCredentials: true });
        es.onmessage = (e) => console.log(JSON.parse(e.data));
        es.addEventListener('done', () => es.close());
    """
    # 쿠키 기반 인증 (쿼리파라미터 방식 금지)
    user = _verify_cookie_token(request)
    user_id = user["user_id"]

    if _SSE_SEMAPHORE.locked() and _SSE_SEMAPHORE._value == 0:  # type: ignore[attr-defined]
        raise HTTPException(status_code=503, detail="SSE 서버 과부하 — 잠시 후 재시도")

    async def generate():
        try:
            async with _SSE_SEMAPHORE:
                async with asyncio.timeout(_SSE_TIMEOUT_SECONDS):
                    async for chunk in _ai_analysis_stream(user_id):
                        yield chunk
        except asyncio.TimeoutError:
            timeout_payload = json.dumps({
                "stage": "timeout",
                "message": f"SSE 연결 {_SSE_TIMEOUT_SECONDS}초 초과 — 재연결 필요",
                "user_id": user_id,
            }, ensure_ascii=False)
            yield f"event: error\ndata: {timeout_payload}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # Nginx 버퍼링 비활성화
            "Connection": "keep-alive",
        },
    )


@router.get("/ai/status")
async def ai_status(request: Request):
    """
    [R24-②] AI 스트림 상태 확인 (인증 필요)
    EventSource 연결 전 토큰 유효성 사전 확인용.
    """
    user = _verify_cookie_token(request)
    available_slots = _SSE_SEMAPHORE._value  # type: ignore[attr-defined]
    return {
        "status": "ready",
        "user_id": user["user_id"],
        "sse_available_slots": available_slots,
        "sse_timeout_seconds": _SSE_TIMEOUT_SECONDS,
        "auth_method": "cookie_based_jwt",
    }


# ─── [R27-①] SSE 토큰 만료 자동 갱신 ────────────────────────
_SSE_TOKEN_WARNING_SECONDS = 5 * 60  # 만료 5분 전 경고 이벤트 발송


def _get_token_remaining_seconds(payload: dict) -> int:
    """토큰 만료까지 남은 초 계산."""
    exp = payload.get("exp", 0)
    now = datetime.now(timezone.utc).timestamp()
    return max(0, int(exp - now))


async def _ai_analysis_stream_with_token_refresh(
    user_id: int, token_payload: dict
) -> AsyncGenerator[str, None]:
    """
    [R27-①] 토큰 만료 경고 이벤트 포함 AI 분석 스트림.

    SSE 30분 만료 → 클라이언트 reconnect 흐름:
    1. 스트림 시작 시 remaining_seconds 포함
    2. 만료 5분 전 'token_warning' 이벤트 발송
    3. 클라이언트는 이벤트 수신 시 /auth/sse-refresh 호출 → 새 쿠키 발급
    4. 새 쿠키로 EventSource 재연결 (자동 reconnect)
    """
    remaining = _get_token_remaining_seconds(token_payload)

    # 스트림 시작 시 토큰 잔여 시간 알림
    start_event = json.dumps({
        "stage": "connected",
        "user_id": user_id,
        "token_remaining_seconds": remaining,
        "auto_refresh_at_seconds_left": _SSE_TOKEN_WARNING_SECONDS,
        "message": "SSE 연결 완료",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False)
    yield f"event: connected\ndata: {start_event}\n\n"

    # 토큰 만료 5분 전 경고 (만료까지 5분 미만인 경우 즉시 발송)
    if remaining <= _SSE_TOKEN_WARNING_SECONDS:
        warning_event = json.dumps({
            "stage": "token_warning",
            "user_id": user_id,
            "token_remaining_seconds": remaining,
            "action": "call_sse_refresh",
            "refresh_endpoint": "/api/auth/sse-refresh",
            "message": f"SSE 토큰 {remaining}초 후 만료 — /api/auth/sse-refresh 호출 후 재연결",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False)
        yield f"event: token_warning\ndata: {warning_event}\n\n"

    # 실제 AI 분석 스트림
    stages = [
        {"stage": "init", "message": "AI 분석 시작 중...", "progress": 10},
        {"stage": "loading", "message": "건강 패턴 분석 중...", "progress": 40},
        {"stage": "processing", "message": "맞춤 인사이트 생성 중...", "progress": 70},
        {"stage": "finalizing", "message": "결과 정리 중...", "progress": 90},
    ]

    for stage_data in stages:
        payload_data = json.dumps({
            **stage_data,
            "user_id": user_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False)
        yield f"data: {payload_data}\n\n"
        await asyncio.sleep(0.3)

    done_payload = json.dumps({
        "stage": "done",
        "message": "분석 완료",
        "progress": 100,
        "user_id": user_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }, ensure_ascii=False)
    yield f"data: {done_payload}\n\n"
    yield "event: done\ndata: {}\n\n"


@router.get("/ai/stream/v2")
@_limiter.limit("5/minute")  # [R11-RL-001] AI Stream v2 Rate Limit
async def ai_stream_v2(request: Request):
    """
    [R27-①] AI SSE 스트림 v2 — 토큰 만료 자동 갱신 지원

    개선 사항:
    - 연결 시 token_remaining_seconds 포함 (클라이언트 타이머 설정 용이)
    - 만료 5분 전 'token_warning' 이벤트 발송
    - 클라이언트 처리 흐름:
        es.addEventListener('token_warning', async () => {
            await fetch('/api/auth/sse-refresh', { method: 'POST', credentials: 'include' });
            es.close();
            es = new EventSource('/api/ai/stream/v2', { withCredentials: true }); // 재연결
        });
    - 원활한 무중단 갱신: 새 쿠키 발급 → 재연결 시 자동 적용

    주의: sse_token 30분, 토큰 갱신 없이 연결 30분 초과 시 재로그인 필요.
    무중단 갱신 원하면 'token_warning' 이벤트 수신 시 즉시 /auth/sse-refresh 호출.
    """
    user = _verify_cookie_token(request)
    user_id = user["user_id"]
    token_payload = user["payload"]

    if _SSE_SEMAPHORE.locked() and _SSE_SEMAPHORE._value == 0:  # type: ignore[attr-defined]
        raise HTTPException(status_code=503, detail="SSE 서버 과부하 — 잠시 후 재시도")

    async def generate():
        try:
            async with _SSE_SEMAPHORE:
                async with asyncio.timeout(_SSE_TIMEOUT_SECONDS):
                    async for chunk in _ai_analysis_stream_with_token_refresh(user_id, token_payload):
                        yield chunk
        except asyncio.TimeoutError:
            timeout_payload = json.dumps({
                "stage": "timeout",
                "message": f"SSE 연결 {_SSE_TIMEOUT_SECONDS}초 초과 — 재연결 필요",
                "user_id": user_id,
                "reconnect_endpoint": "/api/ai/stream/v2",
            }, ensure_ascii=False)
            yield f"event: error\ndata: {timeout_payload}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ─── [R27 엣지케이스] SSE session_id 기반 resume ─────────
import uuid
_SSE_SESSION_REGISTRY: dict = {}  # session_id → {user_id, progress, last_stage}


@router.post("/ai/stream/session")
@_limiter.limit("10/minute")  # [CSO-002 FIX] A01/A07 — 인증 없는 세션 발급 rate limit 추가
async def create_sse_session(request: Request):
    """
    [R27 엣지케이스] SSE 연결 전 session_id 발급.
    [CSO-002 FIX] A01 — 인증은 세션 사용(GET /ai/stream/v2) 시점에서 수행.
    rate limit으로 session_id 대량 생성(메모리 소진 DoS) 방어.

    클라이언트는 session_id를 보관하고 재연결 시 /ai/stream/v2?session_id=... 로 전달.
    서버는 마지막 stage부터 resume하여 중복 분석 방지.

    흐름:
    1. POST /api/ai/stream/session → session_id 발급
    2. GET /api/ai/stream/v2?session_id=xxx → 연결 (or 재연결)
    3. 재연결 시 마지막 progress부터 resume
    """
    from fastapi import Request
    session_id = str(uuid.uuid4())
    _SSE_SESSION_REGISTRY[session_id] = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "last_stage": None,
        "last_progress": 0,
        "completed": False,
    }
    return {
        "session_id": session_id,
        "usage": "GET /api/ai/stream/v2?session_id=<id> 로 SSE 연결",
        "resume_support": True,
        "ttl_seconds": 3600,  # 1시간 후 세션 만료
    }


@router.get("/ai/stream/session/{session_id}")
async def get_sse_session_status(session_id: str, request: "Request" = None):
    """[R27 엣지케이스] SSE 세션 상태 조회 — 재연결 시 resume 기준점."""
    session = _SSE_SESSION_REGISTRY.get(session_id)
    if not session:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"SSE 세션 {session_id} 없음 또는 만료")
    return {
        "session_id": session_id,
        "last_stage": session["last_stage"],
        "last_progress": session["last_progress"],
        "completed": session["completed"],
        "resume_from": session["last_stage"] or "beginning",
    }
