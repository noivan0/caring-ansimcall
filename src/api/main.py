"""
케어링 API 서버 (FastAPI)
법적 포지션: 정보통신서비스 (알림 서비스)
"""
import os as _os
import redis.asyncio as aioredis
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler  # [R11-RL-001]
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from src.api.rate_limiter import limiter  # 순환 임포트 방지 — 공유 인스턴스
from starlette.middleware.base import BaseHTTPMiddleware  # [R54-HDR-001]
from src.core.env import load_project_env

load_project_env()

def _parse_cors_origins(env_val: str, default: str) -> list:
    """[R50-CORS-001 FIX] 와일드카드 차단 — ALLOWED_ORIGINS='*' 시 기본값 사용"""
    raw = (env_val or default).strip()
    if raw == "*" or not raw:
        raw = default
    return [o.strip() for o in raw.split(",") if o.strip()]

# [R54-HDR-001] 보안 응답 헤더 미들웨어 (OWASP A05 — 멘탈로드/사주담과 동일 패턴)
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """X-Frame-Options, X-Content-Type-Options, CSP, HSTS 등 보안 헤더 일괄 적용."""
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https:; "
            "connect-src 'self';"
        )
        if request.url.scheme == "https":
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains; preload"
            )
        return response

# limiter: rate_limiter.py에서 임포트한 공유 인스턴스 사용

# Redis pool singleton — 매 요청 신규 연결 방지 (Pattern 1, weight=0.92 GOLD)
_redis_pool: aioredis.Redis | None = None


def _get_redis() -> aioredis.Redis | None:
    global _redis_pool
    if _redis_pool is None:
        redis_url = _os.getenv("REDIS_URL", "")
        if redis_url:
            _redis_pool = aioredis.Redis.from_url(
                redis_url,
                socket_connect_timeout=1,   # [STRIDE-D-002] 1s (직렬 합산 2.5s < K8s probe 3s)
                socket_timeout=0.5,         # [STRIDE-D-002] 0.5s
                decode_responses=True,
            )
    return _redis_pool


# DB engine singleton — 매 요청 신규 엔진(커넥션 풀) 생성 방지 (STRIDE-D-001 MEDIUM)
_db_engine = None


def _get_db_engine():
    """DATABASE_URL 환경변수 기반 SQLAlchemy 엔진 싱글톤.
    DATABASE_URL 없으면 None 반환 (SQLite 개발환경 / 테스트 스킵 용).
    """
    global _db_engine
    if _db_engine is None:
        db_url = _os.getenv("DATABASE_URL", "")
        if db_url:
            from sqlalchemy import create_engine  # type: ignore[import]
            # SQLite는 connect_timeout 미지원 — PostgreSQL/MySQL 전용 적용
            if db_url.startswith("sqlite"):
                _db_engine = create_engine(db_url, pool_pre_ping=True)
            else:
                _db_engine = create_engine(
                    db_url,
                    pool_pre_ping=True,
                    connect_args={"connect_timeout": 1},  # [STRIDE-D-002] 1s (직렬 합산 2.5s < K8s probe 3s)
                )
    return _db_engine


app = FastAPI(
    title="케어링 API",
    description="가족 소통 지원 알림 서비스 — 의료기기/의료서비스 아님",
    version="0.1.0",
    debug=False,  # [R29-ERR1] 프로덕션 스택트레이스 노출 방지 명시
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]  # [R11-RL-001]
app.add_middleware(SecurityHeadersMiddleware)  # [R54-HDR-001] 보안 헤더 (OWASP A05)

app.add_middleware(
    CORSMiddleware,
    # [R29-CORS] 프로덕션: ALLOWED_ORIGINS env로 도메인 고정
    allow_origins=_parse_cors_origins(_os.getenv("ALLOWED_ORIGINS", ""), "http://localhost:3001"),
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
    allow_credentials=True,
)

from src.api.routes import schedules, family, auth, phone_verify
from src.api.routes.ai_stream import router as ai_stream_router
from src.api.routes.crisis_followup import router as crisis_followup_router

app.include_router(auth.router, prefix="/api/auth")
app.include_router(phone_verify.router, prefix="/api")
app.include_router(schedules.router, prefix="/api/schedules")
app.include_router(family.router, prefix="/api/family")
app.include_router(ai_stream_router, prefix="/api")          # [R24-②] SSE AI 스트림
app.include_router(crisis_followup_router, prefix="/api")   # [R24-③] 위기 팔로업

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "caring-api", "legal": "notification-service-only"}

@app.get("/health/live")
def health_live():
    """Kubernetes liveness probe — 프로세스 생존 여부만 확인"""
    return {"status": "alive", "service": "caring-api"}

@app.get("/health/ready")
async def health_ready():
    """Kubernetes readiness probe — DB + Redis 연결 확인 후 트래픽 수신 가능 여부 반환"""
    from sqlalchemy import text
    checks = {"db": "unknown"}
    all_ok = True

    # DB 엔진 싱글톤 사용 — 매 요청 create_engine() 금지 (STRIDE-D-001)
    engine = _get_db_engine()
    if engine is not None:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            checks["db"] = "ok"
        except Exception:
            checks["db"] = "error"
            all_ok = False
    else:
        # DATABASE_URL 없으면 스킵 (SQLite 개발환경 등)
        checks["db"] = "skipped"

    # Redis ping 체크 (신규)
    redis = _get_redis()
    if redis:
        try:
            await redis.ping()
            checks["redis"] = "ok"
        except Exception:
            checks["redis"] = "error"
            all_ok = False
    else:
        checks["redis"] = "skipped"

    if not all_ok:
        from fastapi import Response
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "service": "caring-api", **checks}
        )
    return {"status": "ready", "service": "caring-api", **checks}

