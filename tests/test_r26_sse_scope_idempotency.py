"""
[R26-①②③④] SSE scope 분리 + idempotency + 법적 근거 + 크론 모니터링 테스트
"""
import pytest
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from unittest.mock import MagicMock
from fastapi import Response
from datetime import datetime, timezone, timedelta


class TestSSETokenScopeSeparation:
    """[R26-①] SSE 전용 토큰 scope/만료 분리"""

    def test_sse_token_expires_30min(self):
        """SSE 토큰 만료 = 30분"""
        import jwt as pyjwt
        from src.core.auth import create_sse_token, SSE_EXPIRE_MINUTES, SECRET_KEY, ALGORITHM
        assert SSE_EXPIRE_MINUTES == 30
        token = create_sse_token(user_id=1)
        payload = pyjwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        iat = datetime.fromtimestamp(payload["iat"], tz=timezone.utc)
        assert 25 <= (exp - iat).total_seconds() / 60 <= 35  # 30분 ±5분

    def test_sse_token_type_is_sse_access(self):
        """SSE 토큰 type = sse_access (일반 access와 구분)"""
        import jwt as pyjwt
        from src.core.auth import create_sse_token, SECRET_KEY, ALGORITHM
        token = create_sse_token(user_id=1)
        payload = pyjwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        assert payload["type"] == "sse_access"
        assert payload["scope"] == "sse:read"

    def test_sse_token_accepted_by_verify_cookie(self):
        """SSE 전용 토큰이 SSE 인증 통과"""
        from src.api.routes.ai_stream import _verify_cookie_token
        from src.core.auth import create_sse_token
        from fastapi import Request

        token = create_sse_token(user_id=42)
        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {"access_token": token}

        user = _verify_cookie_token(mock_request)
        assert user["user_id"] == 42
        assert user["token_type"] == "sse_access"

    def test_regular_access_token_still_accepted(self):
        """일반 access_token도 SSE 인증 통과 (하위 호환)"""
        from src.api.routes.ai_stream import _verify_cookie_token
        from src.core.auth import create_access_token
        from fastapi import Request

        token = create_access_token(user_id=99)
        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {"access_token": token}

        user = _verify_cookie_token(mock_request)
        assert user["user_id"] == 99
        assert user["token_type"] == "access"

    def test_sse_cookie_path_restricted(self):
        """SSE 전용 쿠키는 /api/ai 경로로 scope 제한"""
        from src.api.routes.auth import _SSE_COOKIE_SETTINGS, SSE_EXPIRE_MINUTES
        assert _SSE_COOKIE_SETTINGS["path"] == "/api/ai"
        assert _SSE_COOKIE_SETTINGS["max_age"] == SSE_EXPIRE_MINUTES * 60

    def test_login_cookie_issues_three_cookies(self):
        """로그인 시 3개 쿠키 발급 (access, refresh, sse)"""
        from src.api.routes.auth import login_with_cookie
        from fastapi import Request

        mock_response = MagicMock(spec=Response)
        mock_request = MagicMock(spec=Request)
        mock_request.state = MagicMock()
        result = login_with_cookie(mock_request, mock_response, user_id=1)

        # set_cookie 3회 호출
        assert mock_response.set_cookie.call_count == 3
        assert "scope_separation" in result
        assert "sse_token_cookie" in result


class TestEscalationIdempotency:
    """[R26-②] 에스컬레이션 idempotency"""

    def setup_method(self):
        from src.api.routes import crisis_followup
        crisis_followup._CRISIS_FOLLOWUP_LOG.clear()
        crisis_followup._NOTIFICATION_LOG.clear()
        crisis_followup._ESCALATION_IDEMPOTENCY_LOG.clear()
        crisis_followup._followup_id_counter = 0

    def _make_user(self):
        return {"user_id": 1, "payload": {}}

    def _make_request(self):
        from unittest.mock import MagicMock
        from fastapi import Request
        mock_req = MagicMock(spec=Request)
        mock_req.state = MagicMock()
        return mock_req

    def test_already_escalated_not_re_escalated(self):
        """이미 escalated 상태 → 재에스컬레이션 방지"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, check_and_escalate_overdue_v2,
            _CRISIS_FOLLOWUP_LOG, _NOTIFICATION_LOG, CrisisFollowupRequest,
            FollowupStatus
        )
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=300, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        overdue = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()
        _CRISIS_FOLLOWUP_LOG[0]["scheduled_at"] = overdue

        # 첫 번째 실행
        result1 = loop.run_until_complete(check_and_escalate_overdue_v2(self._make_request(), self._make_user()))
        assert result1["escalated_count"] == 1
        initial_log_count = len(_NOTIFICATION_LOG)

        # 두 번째 실행 (동일 시간대 → idempotency)
        result2 = loop.run_until_complete(check_and_escalate_overdue_v2(self._make_request(), self._make_user()))
        assert result2["escalated_count"] == 0
        assert len(_NOTIFICATION_LOG) == initial_log_count  # 추가 로그 없음

    def test_fallback_recipient_when_no_staff(self):
        """담당자 없는 경우 admin_fallback 수신자"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, check_and_escalate_overdue_v2,
            _CRISIS_FOLLOWUP_LOG, _NOTIFICATION_LOG, CrisisFollowupRequest
        )
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=301, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        overdue = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()
        _CRISIS_FOLLOWUP_LOG[0]["scheduled_at"] = overdue

        loop.run_until_complete(check_and_escalate_overdue_v2(self._make_request(), self._make_user()))

        assert len(_NOTIFICATION_LOG) > 0
        notif = _NOTIFICATION_LOG[-1]
        assert notif["recipient_type"] == "admin_fallback"  # fallback 수신자

    def test_v2_result_has_idempotency_info(self):
        """v2 응답에 idempotency 관련 정보 포함"""
        from src.api.routes.crisis_followup import check_and_escalate_overdue_v2
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            check_and_escalate_overdue_v2(self._make_user())
        )
        assert result["version"] == "v2 (idempotency)"
        assert "skipped_already_escalated" in result


class TestLegalBasisDeletionException:
    """[R26-③] notification-log 파기 예외 법적 근거"""

    def _make_user(self):
        return {"user_id": 1, "payload": {}}

    def test_legal_basis_endpoint_returns_statute(self):
        """법적 근거 엔드포인트 — 자살예방법§4 명시"""
        from src.api.routes.crisis_followup import get_deletion_exception_legal_basis
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            get_deletion_exception_legal_basis(self._make_user())
        )
        assert "자살예방법 제4조" in result["legal_basis"]["statute"]
        assert "개인정보보호법" in result["legal_basis"]["exception_basis"]
        assert result["compliance_status"] == "적법"

    def test_legal_basis_includes_personal_info_act_ref(self):
        """개인정보보호법 파기 예외 근거 포함"""
        from src.api.routes.crisis_followup import _LEGAL_DELETION_EXCEPTION

        assert "개인정보보호법" in _LEGAL_DELETION_EXCEPTION["exception_basis"]
        assert "제21조" in _LEGAL_DELETION_EXCEPTION["personal_info_act_ref"]
        assert _LEGAL_DELETION_EXCEPTION["deletion_type"] == "소프트 삭제 (하드 삭제 불가)"


class TestEscalationCronMonitoring:
    """[R26-④] 에스컬레이션 크론 모니터링"""

    def _make_user(self):
        return {"user_id": 1, "payload": {}}

    def _make_request(self):
        from unittest.mock import MagicMock
        from fastapi import Request
        mock_req = MagicMock(spec=Request)
        mock_req.state = MagicMock()
        return mock_req

    def setup_method(self):
        from src.api.routes import crisis_followup
        crisis_followup._ESCALATION_CRON_HEARTBEAT["last_run_at"] = None
        crisis_followup._ESCALATION_CRON_HEARTBEAT["run_count"] = 0
        crisis_followup._ESCALATION_CRON_HEARTBEAT["consecutive_failures"] = 0

    def test_heartbeat_records_success(self):
        """성공 heartbeat → consecutive_failures 초기화"""
        from src.api.routes.crisis_followup import escalation_cron_heartbeat
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            escalation_cron_heartbeat(self._make_request(), self._make_user(), success=True)
        )
        assert result["heartbeat_recorded"] is True
        assert result["consecutive_failures"] == 0
        assert result["alert_triggered"] is False

    def test_heartbeat_failure_increments_counter(self):
        """실패 heartbeat → consecutive_failures 증가"""
        from src.api.routes.crisis_followup import escalation_cron_heartbeat
        import asyncio
        loop = asyncio.get_event_loop()

        loop.run_until_complete(escalation_cron_heartbeat(self._make_request(), self._make_user(), success=False))
        loop.run_until_complete(escalation_cron_heartbeat(self._make_request(), self._make_user(), success=False))
        result = loop.run_until_complete(escalation_cron_heartbeat(self._make_request(), self._make_user(), success=False))

        assert result["consecutive_failures"] == 3
        assert result["alert_triggered"] is True
        assert "❗" in (result["alert_message"] or "")

    def test_health_endpoint_never_run(self):
        """한 번도 실행 안 된 크론 → never_run + unhealthy"""
        from src.api.routes.crisis_followup import escalation_cron_health
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            escalation_cron_health(self._make_user())
        )
        assert result["status"] == "never_run"
        assert result["healthy"] is False

    def test_health_endpoint_after_heartbeat(self):
        """heartbeat 후 health 상태 확인"""
        from src.api.routes.crisis_followup import escalation_cron_heartbeat, escalation_cron_health
        import asyncio
        loop = asyncio.get_event_loop()

        loop.run_until_complete(escalation_cron_heartbeat(self._make_request(), self._make_user(), success=True))
        result = loop.run_until_complete(escalation_cron_health(self._make_user()))

        assert result["status"] == "healthy"
        assert result["healthy"] is True
        assert result["overdue_hours"] is not None
        assert "자살예방법" in result["legal_importance"]

    def test_health_legal_importance_mentioned(self):
        """헬스체크 응답에 자살예방법§4 연관성 명시"""
        from src.api.routes.crisis_followup import escalation_cron_health
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            escalation_cron_health(self._make_user())
        )
        assert "자살예방법" in result["legal_importance"]
