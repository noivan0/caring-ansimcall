"""
케어링 테스트 공통 픽스처 — 환경 변수 자동 주입
"""
import os
import pytest
from unittest.mock import MagicMock

# 테스트용 환경변수 (실제 배포 키와 무관한 테스트 전용 값)
os.environ.setdefault("SECRET_KEY", "test-secret-key-caring-32chars-min")
os.environ.setdefault("REFRESH_SECRET_KEY", "test-refresh-secret-key-caring-32chars")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("TWILIO_ACCOUNT_SID", "ACtest00000000000000000000000000000")
os.environ.setdefault("TWILIO_AUTH_TOKEN", "test_auth_token_caring_12345678901")
os.environ.setdefault("TWILIO_PHONE_NUMBER", "+155****0100")
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_caring.db")
os.environ.setdefault("ENVIRONMENT", "test")


def make_mock_request():
    """SlowAPI limiter가 요구하는 mock Request 객체 반환."""
    from fastapi import Request
    mock_req = MagicMock(spec=Request)
    mock_req.state = MagicMock()
    mock_req.state._rate_limit_exceeded = False
    return mock_req


@pytest.fixture(autouse=True)
def disable_rate_limiter(monkeypatch):
    """
    테스트 환경에서 SlowAPI rate limiter를 비활성화.
    unit test는 rate limit 로직이 아니라 비즈니스 로직을 검증.
    """
    try:
        from src.api.rate_limiter import limiter
        monkeypatch.setattr(limiter, "enabled", False)
    except Exception:
        pass  # limiter 없으면 패스
