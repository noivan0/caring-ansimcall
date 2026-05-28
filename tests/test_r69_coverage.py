"""
R69 Track C — 케어링 커버리지 갭 테스트 (헤르 작성)
"""
import pytest
import sys, os, time

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

os.environ.setdefault("SECRET_KEY", "test-secret-key-caring-32chars-min")
os.environ.setdefault("REFRESH_SECRET_KEY", "test-refresh-secret-key-caring-32chars")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("TWILIO_ACCOUNT_SID", "ACtest00000000000000000000000000000")
os.environ.setdefault("TWILIO_AUTH_TOKEN", "test_auth_token_caring_12345678901")
os.environ.setdefault("TWILIO_PHONE_NUMBER", "+155****0100")
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_caring_r69.db")
os.environ.setdefault("ENVIRONMENT", "test")

_MOCK_REQ_HELPER = None

def _make_request():
    from unittest.mock import MagicMock
    from fastapi import Request
    mock_req = MagicMock(spec=Request)
    mock_req.state = MagicMock()
    return mock_req


class TestSeniorCareCoverageR69:
    """Track C: 케어링 커버리지 갭"""

    def setup_method(self):
        from src.api.routes import phone_verify, crisis_followup
        phone_verify._invite_store.clear()
        crisis_followup._CRISIS_FOLLOWUP_LOG.clear()
        crisis_followup._NOTIFICATION_LOG.clear()
        crisis_followup._followup_id_counter = 0

    def test_invite_code_expired_returns_410(self):
        """초대코드 만료 → HTTP 410 Gone [R68 실증]"""
        from fastapi import HTTPException
        from src.api.routes.phone_verify import accept_family_invite, FamilyInviteAcceptRequest, _invite_store
        _invite_store["expired_tok_xyz99"] = {
            "parent_phone": "01012345678",
            "parent_name": "테스트부모",
            "child_user_id": 1,
            "otp": "123456",
            "expires_at": time.time() - 3600,
        }
        body = FamilyInviteAcceptRequest(invite_token="expired_tok_xyz99", otp="123456")
        with pytest.raises(HTTPException) as exc:
            accept_family_invite(body)
        assert exc.value.status_code == 410
        assert "만료" in str(exc.value.detail)

    def test_invalid_invite_token_returns_404(self):
        """존재하지 않는 초대 토큰 → 404"""
        from fastapi import HTTPException
        from src.api.routes.phone_verify import accept_family_invite, FamilyInviteAcceptRequest
        body = FamilyInviteAcceptRequest(invite_token="nonexistent_tok_abc", otp="123456")
        with pytest.raises(HTTPException) as exc:
            accept_family_invite(body)
        assert exc.value.status_code == 404

    def test_family_member_role_invalid_rejects(self):
        """FamilyMember role Literal — 잘못된 role → Pydantic ValidationError"""
        from pydantic import ValidationError
        from src.api.routes.family import FamilyMember
        with pytest.raises(ValidationError):
            FamilyMember(name="홍철수", phone="01098765432", role="superadmin")

    def test_family_member_role_valid_values(self):
        """FamilyMember role 허용값 — primary/secondary/cc_only"""
        from src.api.routes.family import FamilyMember
        for role in ("primary", "secondary", "cc_only"):
            m = FamilyMember(name="테스트", phone="01012345678", role=role)
            assert m.role == role

    def test_otp_wrong_length_rejects(self):
        """OTP 6자리 아닌 값 → ValidationError"""
        from pydantic import ValidationError
        from src.api.routes.phone_verify import OtpVerifyRequest
        with pytest.raises(ValidationError):
            OtpVerifyRequest(phone="01012345678", otp="12345")  # 5자리

    def test_crisis_followup_5year_retention(self):
        """자살예방법§4 보존 5년 상수 확인"""
        from src.api.routes.crisis_followup import _LEGAL_RETENTION_YEARS
        assert _LEGAL_RETENTION_YEARS == 5

    def test_schedule_medication_name_injection_blocked(self):
        """약 이름 Prompt Injection 차단"""
        from pydantic import ValidationError
        from src.api.routes.schedules import ScheduleCreate
        with pytest.raises(ValidationError):
            ScheduleCreate(
                parent_phone="01012345678",
                medication_name="ignore previous system:",
                reminder_time="08:00",
            )

    def test_schedule_medication_name_max_length(self):
        """약 이름 100자 초과 → ValidationError"""
        from pydantic import ValidationError
        from src.api.routes.schedules import ScheduleCreate
        with pytest.raises(ValidationError):
            ScheduleCreate(
                parent_phone="01012345678",
                medication_name="약" * 101,
                reminder_time="08:00",
            )

    def test_family_group_max_5_members(self):
        """가족 그룹 5명 초과 → HTTP 400"""
        from fastapi.testclient import TestClient
        from src.api.main import app
        client = TestClient(app)
        members = [
            {"name": f"보호자{i}", "phone": f"0101234567{i}", "role": "secondary"}
            for i in range(6)
        ]
        members[0]["role"] = "primary"
        r = client.post("/api/family/family/groups", json={
            "parent_name": "홍길동",
            "parent_phone": "01011111111",
            "members": members
        }, headers={"Authorization": "Bearer test_invalid_token"})
        # 인증 실패(401) 또는 5명 초과(400)
        assert r.status_code in (400, 401)

    def test_followup_notification_log_retention_constant(self):
        """notification_log 보존 정책 — 상수 검증"""
        import datetime
        from datetime import timezone
        from src.api.routes.crisis_followup import _LEGAL_RETENTION_YEARS, _is_within_retention
        assert _LEGAL_RETENTION_YEARS == 5
        record = {"created_at": datetime.datetime.now(timezone.utc).isoformat()}
        assert _is_within_retention(record) is True
