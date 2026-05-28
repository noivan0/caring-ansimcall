"""
[R25-①②③] CSRF 방어 + 삭제 방지 + 자동 에스컬레이션 테스트
"""
import pytest
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from unittest.mock import MagicMock
from fastapi import Request


class TestCookieCSRFDefense:
    """[R25-①] 쿠키 보안 설정 검증"""

    def test_cookie_settings_samesite_strict(self):
        """SameSite=Strict 설정 확인"""
        from src.api.routes.auth import _COOKIE_SETTINGS
        assert _COOKIE_SETTINGS["samesite"] == "strict"

    def test_cookie_settings_httponly(self):
        """HttpOnly 설정 확인"""
        from src.api.routes.auth import _COOKIE_SETTINGS
        assert _COOKIE_SETTINGS["httponly"] is True

    def test_cookie_settings_secure(self):
        """HTTPS 전용 secure 설정 확인"""
        from src.api.routes.auth import _COOKIE_SETTINGS
        assert _COOKIE_SETTINGS["secure"] is True

    def test_refresh_cookie_restricted_path(self):
        """refresh_token 쿠키는 refresh 엔드포인트에만 전송"""
        from src.api.routes.auth import _REFRESH_COOKIE_SETTINGS
        assert "/auth/refresh" in _REFRESH_COOKIE_SETTINGS["path"]

    def test_cookie_max_age_24h(self):
        """access_token 쿠키 만료 = 24h"""
        from src.api.routes.auth import _COOKIE_SETTINGS
        assert _COOKIE_SETTINGS["max_age"] == 60 * 60 * 24

    def test_login_cookie_endpoint_returns_csrf_info(self):
        """로그인 응답에 CSRF 방어 정보 포함"""
        from src.api.routes.auth import login_with_cookie
        from fastapi import Response, Request

        mock_response = MagicMock(spec=Response)
        mock_request = MagicMock(spec=Request)
        mock_request.state = MagicMock()
        result = login_with_cookie(mock_request, mock_response, user_id=1)

        assert result["auth_method"] == "cookie"
        assert result["csrf_protection"] == "SameSite=Strict"
        # set_cookie 호출 확인
        assert mock_response.set_cookie.called

    def test_logout_deletes_cookie(self):
        """로그아웃 시 쿠키 명시적 삭제"""
        from src.api.routes.auth import logout
        from fastapi import Response, Request

        mock_response = MagicMock(spec=Response)
        mock_request = MagicMock(spec=Request); mock_request.state = MagicMock()
        mock_user = {"user_id": 1, "payload": {}}
        result = logout(mock_request, mock_response, mock_user)

        assert "삭제됨" in result["message"]
        # delete_cookie 호출 확인
        assert mock_response.delete_cookie.called


class TestNotificationLogRetention:
    """[R25-②] notification-log 5년 보존 정책"""

    def setup_method(self):
        from src.api.routes import crisis_followup
        crisis_followup._CRISIS_FOLLOWUP_LOG.clear()
        crisis_followup._NOTIFICATION_LOG.clear()
        crisis_followup._followup_id_counter = 0

    def _make_user(self, user_id: int = 1):
        return {"user_id": user_id, "payload": {}}

    def _make_request(self):
        from unittest.mock import MagicMock
        from fastapi import Request
        mock_req = MagicMock(spec=Request)
        mock_req.state = MagicMock()
        return mock_req

    def test_delete_within_retention_blocked_403(self):
        """5년 보존 기간 내 삭제 차단 → 403"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, notify_followup, delete_notification_log,
            CrisisFollowupRequest, FollowupNotifyRequest
        )
        from fastapi import HTTPException
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=100, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))
        notify_body = FollowupNotifyRequest(followup_id=1, channel="sms", recipient_type="guardian")
        loop.run_until_complete(notify_followup(self._make_request(), notify_body, self._make_user()))

        # 삭제 시도 → 403
        with pytest.raises(HTTPException) as exc_info:
            loop.run_until_complete(delete_notification_log(self._make_request(), 1, self._make_user()))
        assert exc_info.value.status_code == 403
        assert "보존 기간" in str(exc_info.value.detail)

    def test_retention_policy_5_years(self):
        """보존 정책이 5년인지 확인"""
        from src.api.routes.crisis_followup import _LEGAL_RETENTION_YEARS
        assert _LEGAL_RETENTION_YEARS == 5

    def test_retention_policy_endpoint(self):
        """보존 정책 엔드포인트 응답 구조"""
        from src.api.routes.crisis_followup import get_retention_policy
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            get_retention_policy(self._make_user())
        )
        assert result["retention_years"] == 5
        assert "자살예방법" in result["legal_basis"]
        assert result["delete_policy"] == "보존 기간 내 삭제 불가 (HTTP 403 반환)"

    def test_nonexistent_notification_returns_404(self):
        """존재하지 않는 알림 로그 삭제 → 404"""
        from src.api.routes.crisis_followup import delete_notification_log
        from fastapi import HTTPException
        import asyncio

        with pytest.raises(HTTPException) as exc_info:
            asyncio.get_event_loop().run_until_complete(
                delete_notification_log(self._make_request(), 9999, self._make_user())
            )
        assert exc_info.value.status_code == 404


class TestFollowupAutoEscalation:
    """[R25-③] 팔로업 자동 에스컬레이션"""

    def setup_method(self):
        from src.api.routes import crisis_followup
        crisis_followup._CRISIS_FOLLOWUP_LOG.clear()
        crisis_followup._NOTIFICATION_LOG.clear()
        crisis_followup._followup_id_counter = 0

    def _make_user(self, user_id: int = 1):
        return {"user_id": user_id, "payload": {}}

    def _make_request(self):
        from unittest.mock import MagicMock
        from fastapi import Request
        mock_req = MagicMock(spec=Request)
        mock_req.state = MagicMock()
        return mock_req

    def test_overdue_pending_escalated(self):
        """scheduled_at 24h 초과 미이행 → 자동 escalated"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, check_and_escalate_overdue,
            _CRISIS_FOLLOWUP_LOG, CrisisFollowupRequest
        )
        from datetime import datetime, timezone, timedelta
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=200, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        # 36h 전 scheduled_at으로 조작
        overdue_time = (datetime.now(timezone.utc) - timedelta(hours=36)).isoformat()
        _CRISIS_FOLLOWUP_LOG[0]["scheduled_at"] = overdue_time

        result = loop.run_until_complete(check_and_escalate_overdue(self._make_request(), self._make_user()))

        assert result["escalated_count"] == 1
        assert 1 in result["escalated_followup_ids"]
        assert _CRISIS_FOLLOWUP_LOG[0]["status"] == "escalated"

    def test_escalation_creates_notification_log(self):
        """자동 에스컬레이션 → notification_log 생성"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, check_and_escalate_overdue,
            _CRISIS_FOLLOWUP_LOG, _NOTIFICATION_LOG, CrisisFollowupRequest
        )
        from datetime import datetime, timezone, timedelta
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=201, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))
        overdue_time = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()
        _CRISIS_FOLLOWUP_LOG[0]["scheduled_at"] = overdue_time

        loop.run_until_complete(check_and_escalate_overdue(self._make_request(), self._make_user()))

        assert len(_NOTIFICATION_LOG) == 1
        notif = _NOTIFICATION_LOG[0]
        assert notif["channel"] == "system_escalation"
        assert notif["recipient_type"] == "supervisor"
        assert notif["sent_by_user_id"] == "SYSTEM"
        assert "자살예방법" in notif["legal_evidence"]["statute"]

    def test_not_overdue_not_escalated(self):
        """scheduled_at 미도래 → 에스컬레이션 없음"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, check_and_escalate_overdue,
            _CRISIS_FOLLOWUP_LOG, CrisisFollowupRequest
        )
        from datetime import datetime, timezone, timedelta
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=202, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))
        # 1h 뒤 scheduled → 아직 미도래
        future_time = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        _CRISIS_FOLLOWUP_LOG[0]["scheduled_at"] = future_time

        result = loop.run_until_complete(check_and_escalate_overdue(self._make_request(), self._make_user()))
        assert result["escalated_count"] == 0

    def test_already_notified_marked_completed(self):
        """알림 발송 완료 팔로업 → escalated 아닌 completed"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, notify_followup, check_and_escalate_overdue,
            _CRISIS_FOLLOWUP_LOG, CrisisFollowupRequest, FollowupNotifyRequest
        )
        from datetime import datetime, timezone, timedelta
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=203, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        # 알림 먼저 발송
        notify_body = FollowupNotifyRequest(followup_id=1, channel="sms", recipient_type="guardian")
        loop.run_until_complete(notify_followup(self._make_request(), notify_body, self._make_user()))

        # 기한 초과로 조작
        overdue_time = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()
        _CRISIS_FOLLOWUP_LOG[0]["scheduled_at"] = overdue_time
        _CRISIS_FOLLOWUP_LOG[0]["status"] = "pending"  # escalated 상태 초기화

        result = loop.run_until_complete(check_and_escalate_overdue(self._make_request(), self._make_user()))
        # 알림이 있으므로 escalated가 아닌 completed
        assert _CRISIS_FOLLOWUP_LOG[0]["status"] == "completed"
        assert result["escalated_count"] == 0
