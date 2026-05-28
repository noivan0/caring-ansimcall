"""
케어링 Phase 2 — 양측 동의 가족 초대 테스트
"""
import pytest
import time
import secrets
from unittest.mock import patch
from starlette.testclient import TestClient


@pytest.fixture(autouse=True)
def clear_invite_store():
    from src.api.routes.phone_verify import _invite_store
    _invite_store.clear()
    yield
    _invite_store.clear()


@pytest.fixture
def client_with_auth():
    """인증 override가 적용된 TestClient"""
    import os
    os.environ.setdefault("SECRET_KEY", "test-secret")
    os.environ.setdefault("REFRESH_SECRET_KEY", "test-refresh")
    from src.api.main import app
    from src.core.auth import get_current_user
    app.dependency_overrides[get_current_user] = lambda: {"user_id": 42}
    c = TestClient(app)
    yield c
    app.dependency_overrides.clear()


@pytest.fixture
def client_no_auth():
    """인증 불필요 엔드포인트용 TestClient"""
    import os
    os.environ.setdefault("SECRET_KEY", "test-secret")
    os.environ.setdefault("REFRESH_SECRET_KEY", "test-refresh")
    from src.api.main import app
    c = TestClient(app)
    yield c


def test_send_family_invite_success(client_with_auth):
    """정상 초대 SMS 발송"""
    with patch("src.api.routes.phone_verify._send_sms") as mock_sms:
        resp = client_with_auth.post("/api/auth/phone/family/invite", json={
            "parent_phone": "+821012345678",
            "parent_name": "홍길동",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert "invite_token" in data
        mock_sms.assert_called_once()


def test_accept_invite_success(client_no_auth):
    """부모님 OTP 인증 + 동의 완료"""
    from src.api.routes.phone_verify import _invite_store

    token = secrets.token_urlsafe(24)
    _invite_store[token] = {
        "child_user_id": 42,
        "parent_phone": "+821012345678",
        "parent_name": "홍길동",
        "otp": "123456",
        "expires_at": time.time() + 86400,
        "status": "pending",
    }

    resp = client_no_auth.post("/api/auth/phone/family/invite/accept", json={
        "invite_token": token,
        "otp": "123456",
    })
    assert resp.status_code == 200
    assert resp.json()["consented"] is True
    # 재사용 불가 확인
    assert token not in _invite_store


def test_accept_invite_wrong_otp(client_no_auth):
    """틀린 OTP 거부"""
    from src.api.routes.phone_verify import _invite_store

    token = secrets.token_urlsafe(24)
    _invite_store[token] = {
        "child_user_id": 42,
        "parent_phone": "+821012345678",
        "parent_name": "홍길동",
        "otp": "123456",
        "expires_at": time.time() + 86400,
        "status": "pending",
    }

    resp = client_no_auth.post("/api/auth/phone/family/invite/accept", json={
        "invite_token": token,
        "otp": "999999",
    })
    assert resp.status_code == 400


def test_accept_invite_expired(client_no_auth):
    """만료된 초대 거부"""
    from src.api.routes.phone_verify import _invite_store

    token = secrets.token_urlsafe(24)
    _invite_store[token] = {
        "child_user_id": 42,
        "parent_phone": "+821012345678",
        "parent_name": "홍길동",
        "otp": "123456",
        "expires_at": 0,  # 과거 시각
        "status": "pending",
    }

    resp = client_no_auth.post("/api/auth/phone/family/invite/accept", json={
        "invite_token": token,
        "otp": "123456",
    })
    assert resp.status_code == 410


def test_accept_invite_invalid_token(client_no_auth):
    """존재하지 않는 토큰 거부"""
    resp = client_no_auth.post("/api/auth/phone/family/invite/accept", json={
        "invite_token": "nonexistent-token",
        "otp": "123456",
    })
    assert resp.status_code == 404
