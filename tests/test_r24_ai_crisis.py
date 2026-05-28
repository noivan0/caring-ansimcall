"""
[R24-②③] AI SSE 스트림 + 위기 팔로업 테스트
자살예방법§4 이행 증거 생성 검증
"""
import pytest
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient


# ─── /ai/stream 인증 테스트 ───────────────────────────────────
class TestAiStreamAuth:
    """[R24-②] /ai/stream SSE 쿠키 기반 인증"""

    def test_no_cookie_returns_401(self):
        """쿠키 없으면 401 반환"""
        from src.api.routes.ai_stream import _verify_cookie_token
        from fastapi import Request
        from fastapi import HTTPException

        # access_token 쿠키 없는 request mock
        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {}

        with pytest.raises(HTTPException) as exc_info:
            _verify_cookie_token(mock_request)
        assert exc_info.value.status_code == 401
        assert "access_token 쿠키" in exc_info.value.detail

    def test_invalid_token_returns_401(self):
        """유효하지 않은 토큰 → 401"""
        from src.api.routes.ai_stream import _verify_cookie_token
        from fastapi import Request, HTTPException

        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {"access_token": "invalid.token.here"}

        with pytest.raises(HTTPException) as exc_info:
            _verify_cookie_token(mock_request)
        assert exc_info.value.status_code == 401

    def test_valid_access_token_passes(self):
        """유효한 access_token 쿠키 → 사용자 반환"""
        from src.api.routes.ai_stream import _verify_cookie_token
        from src.core.auth import create_access_token
        from fastapi import Request

        token = create_access_token(user_id=42)
        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {"access_token": token}

        user = _verify_cookie_token(mock_request)
        assert user["user_id"] == 42

    def test_refresh_token_blocked(self):
        """refresh token으로 SSE 접근 차단"""
        from src.api.routes.ai_stream import _verify_cookie_token
        from src.core.auth import create_refresh_token
        from fastapi import Request, HTTPException

        token = create_refresh_token(user_id=42)
        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {"access_token": token}

        with pytest.raises(HTTPException) as exc_info:
            _verify_cookie_token(mock_request)
        assert exc_info.value.status_code == 401
        assert "refresh" in exc_info.value.detail

    def test_query_param_token_not_supported(self):
        """쿼리파라미터 토큰 방식 미지원 — 쿠키 없으면 항상 401"""
        from src.api.routes.ai_stream import _verify_cookie_token
        from fastapi import Request, HTTPException

        # 쿼리파라미터에 token이 있어도 쿠키 없으면 차단
        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {}  # 쿠키 없음
        mock_request.query_params = {"token": "some_token"}  # 쿼리파라미터 무시

        with pytest.raises(HTTPException) as exc_info:
            _verify_cookie_token(mock_request)
        assert exc_info.value.status_code == 401

    def test_ai_status_endpoint_structure(self):
        """[R24-②] /ai/status 응답 구조 확인"""
        from src.api.routes.ai_stream import ai_status
        from src.core.auth import create_access_token
        from fastapi import Request
        import asyncio

        token = create_access_token(user_id=99)
        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {"access_token": token}

        result = asyncio.get_event_loop().run_until_complete(ai_status(mock_request))
        assert result["status"] == "ready"
        assert result["user_id"] == 99
        assert result["auth_method"] == "cookie_based_jwt"
        assert "sse_timeout_seconds" in result


# ─── 위기 팔로업 테스트 ───────────────────────────────────────
class TestCrisisFollowup:
    """[R24-③] 위기 팔로업 — 자살예방법§4 이행 증거"""

    def setup_method(self):
        """각 테스트 전 팔로업 로그 초기화"""
        from src.api.routes import crisis_followup
        crisis_followup._CRISIS_FOLLOWUP_LOG.clear()
        crisis_followup._NOTIFICATION_LOG.clear()
        crisis_followup._followup_id_counter = 0

    def _make_user(self, user_id: int = 1):
        return {"user_id": user_id, "payload": {"sub": str(user_id), "type": "access"}}

    def _make_request(self):
        from unittest.mock import MagicMock
        from fastapi import Request
        mock_req = MagicMock(spec=Request)
        mock_req.state = MagicMock()
        return mock_req

    def test_register_followup_returns_201(self):
        """팔로업 등록 — 201 반환 + 법적 근거 포함"""
        from src.api.routes.crisis_followup import register_crisis_followup, CrisisFollowupRequest
        import asyncio

        body = CrisisFollowupRequest(senior_id=100, crisis_type="자해위험", interval="24h")
        result = asyncio.get_event_loop().run_until_complete(
            register_crisis_followup(self._make_request(), body, self._make_user())
        )
        assert result["followup_id"] == 1
        assert result["status"] == "pending"
        assert "자살예방법" in result["legal_basis"]
        assert "scheduled_at" in result

    def test_followup_status_is_pending_on_register(self):
        """등록 직후 상태 = pending"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, get_followup, CrisisFollowupRequest
        )
        import asyncio

        body = CrisisFollowupRequest(senior_id=101, crisis_type="자살충동")
        asyncio.get_event_loop().run_until_complete(
            register_crisis_followup(self._make_request(), body, self._make_user())
        )
        record = asyncio.get_event_loop().run_until_complete(
            get_followup(1, self._make_user())
        )
        assert record["status"] == "pending"

    def test_legal_evidence_saved_on_register(self):
        """등록 시 legal_evidence 필드 저장 확인"""
        from src.api.routes.crisis_followup import register_crisis_followup, _CRISIS_FOLLOWUP_LOG, CrisisFollowupRequest
        import asyncio

        body = CrisisFollowupRequest(senior_id=102, crisis_type="심각한우울")
        asyncio.get_event_loop().run_until_complete(
            register_crisis_followup(self._make_request(), body, self._make_user())
        )
        assert len(_CRISIS_FOLLOWUP_LOG) == 1
        record = _CRISIS_FOLLOWUP_LOG[0]
        assert "legal_evidence" in record
        assert record["legal_evidence"]["statute"] == "자살예방법 제4조"
        assert "registered_at" in record["legal_evidence"]

    def test_notification_log_saved_on_notify(self):
        """알림 발송 후 notification_log 저장 확인 (법적 증거)"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, notify_followup,
            _NOTIFICATION_LOG, CrisisFollowupRequest, FollowupNotifyRequest
        )
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=103, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        notify_body = FollowupNotifyRequest(followup_id=1, channel="sms", recipient_type="guardian")
        result = loop.run_until_complete(notify_followup(self._make_request(), notify_body, self._make_user()))

        assert result["legal_log_saved"] is True
        assert len(_NOTIFICATION_LOG) == 1
        notification = _NOTIFICATION_LOG[0]
        assert notification["channel"] == "sms"
        assert notification["recipient_type"] == "guardian"
        assert "legal_evidence" in notification
        assert notification["legal_evidence"]["statute"] == "자살예방법 제4조"

    def test_followup_escalated_after_notify(self):
        """보호자 알림 후 상태 → escalated"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, notify_followup,
            get_followup, CrisisFollowupRequest, FollowupNotifyRequest
        )
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=104, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        notify_body = FollowupNotifyRequest(followup_id=1, channel="sms", recipient_type="guardian")
        loop.run_until_complete(notify_followup(self._make_request(), notify_body, self._make_user()))

        record = loop.run_until_complete(get_followup(1, self._make_user()))
        assert record["status"] == "escalated"

    def test_list_followups_pending_first(self):
        """팔로업 목록 — pending 우선 정렬"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, notify_followup, list_followups,
            CrisisFollowupRequest, FollowupNotifyRequest, FollowupStatus
        )
        import asyncio
        loop = asyncio.get_event_loop()

        # 두 개 등록
        for i in range(2):
            body = CrisisFollowupRequest(senior_id=200+i, crisis_type="위기")
            loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        # 첫 번째 에스컬레이션
        notify_body = FollowupNotifyRequest(followup_id=1, channel="sms", recipient_type="guardian")
        loop.run_until_complete(notify_followup(self._make_request(), notify_body, self._make_user()))

        result = loop.run_until_complete(list_followups(None, self._make_user()))
        assert result["pending_count"] == 1
        # escalated가 먼저 나옴 (priority 1 < pending priority 0? no — pending=0 comes first)
        statuses = [r["status"] for r in result["followups"]]
        assert statuses[0] == "pending"

    def test_cancelled_followup_blocks_notify(self):
        """취소된 팔로업에 알림 발송 차단"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, update_followup_status, notify_followup,
            CrisisFollowupRequest, FollowupStatusUpdateRequest, FollowupNotifyRequest, FollowupStatus
        )
        from fastapi import HTTPException
        import asyncio
        loop = asyncio.get_event_loop()

        body = CrisisFollowupRequest(senior_id=105, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        # 취소
        update_body = FollowupStatusUpdateRequest(followup_id=1, new_status=FollowupStatus.CANCELLED)
        loop.run_until_complete(update_followup_status(self._make_request(), update_body, self._make_user()))

        # 취소된 팔로업에 알림 시도 → 409
        notify_body = FollowupNotifyRequest(followup_id=1, channel="sms", recipient_type="guardian")
        with pytest.raises(HTTPException) as exc_info:
            loop.run_until_complete(notify_followup(self._make_request(), notify_body, self._make_user()))
        assert exc_info.value.status_code == 409

    def test_notification_log_endpoint_returns_legal_basis(self):
        """notification-log 엔드포인트 법적 근거 포함 확인"""
        from src.api.routes.crisis_followup import get_notification_log
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            get_notification_log(self._make_user())
        )
        assert "자살예방법" in result["legal_basis"]
        assert "total_notifications" in result
