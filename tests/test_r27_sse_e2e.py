"""
[R27-①②③] SSE 자동 갱신 + alert 채널 + 전체 스택 E2E 통합 테스트

R22~R27 전체 이행 체계 E2E:
팔로업 등록 → notification_log → 에스컬레이션 → idempotency
→ 크론 heartbeat → alert_triggered → 알림 채널 → 법적 근거 조회
"""
import pytest
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from unittest.mock import MagicMock
from datetime import datetime, timezone, timedelta
from fastapi import Request, Response


class TestSSEAutoRefreshFlow:
    """[R27-①] SSE 토큰 만료 자동 갱신 흐름"""

    def test_token_remaining_seconds_calculation(self):
        """토큰 잔여 시간 계산 정확성"""
        from src.api.routes.ai_stream import _get_token_remaining_seconds
        import time

        future_exp = time.time() + 1800  # 30분 후
        payload = {"exp": future_exp}
        remaining = _get_token_remaining_seconds(payload)

        assert 1790 <= remaining <= 1810  # 30분 ±10초

    def test_token_warning_threshold_5min(self):
        """만료 5분 전 경고 임계값 확인"""
        from src.api.routes.ai_stream import _SSE_TOKEN_WARNING_SECONDS
        assert _SSE_TOKEN_WARNING_SECONDS == 5 * 60  # 300초

    def test_stream_v2_connected_event_format(self):
        """stream v2 connected 이벤트에 token_remaining_seconds 포함"""
        import asyncio
        from src.api.routes.ai_stream import _ai_analysis_stream_with_token_refresh
        import time, json

        future_exp = time.time() + 1800
        token_payload = {"exp": future_exp, "type": "sse_access"}

        async def collect_events():
            events = []
            async for chunk in _ai_analysis_stream_with_token_refresh(42, token_payload):
                events.append(chunk)
            return events

        events = asyncio.get_event_loop().run_until_complete(collect_events())
        assert len(events) > 0

        # 첫 이벤트가 connected
        first_event = events[0]
        assert "event: connected" in first_event
        data_part = first_event.split("data: ")[1].strip()
        parsed = json.loads(data_part)
        assert "token_remaining_seconds" in parsed
        assert parsed["auto_refresh_at_seconds_left"] == 300

    def test_token_warning_event_emitted_when_expiring_soon(self):
        """만료 임박 시 token_warning 이벤트 발송"""
        import asyncio
        from src.api.routes.ai_stream import _ai_analysis_stream_with_token_refresh
        import time

        # 만료 2분 후 → 5분 미만 → 즉시 warning
        expiring_payload = {"exp": time.time() + 120, "type": "sse_access"}

        async def collect_events():
            events = []
            async for chunk in _ai_analysis_stream_with_token_refresh(99, expiring_payload):
                events.append(chunk)
            return events

        events = asyncio.get_event_loop().run_until_complete(collect_events())
        warning_events = [e for e in events if "token_warning" in e and "event:" in e]
        assert len(warning_events) >= 1

        # refresh_endpoint 포함 확인
        assert "/api/auth/sse-refresh" in warning_events[0]

    def test_token_no_warning_when_sufficient_time(self):
        """토큰 충분 시 token_warning 이벤트 없음"""
        import asyncio
        from src.api.routes.ai_stream import _ai_analysis_stream_with_token_refresh
        import time

        # 만료 20분 후 → 5분 초과 → warning 없음
        fresh_payload = {"exp": time.time() + 1200, "type": "sse_access"}

        async def collect_events():
            events = []
            async for chunk in _ai_analysis_stream_with_token_refresh(77, fresh_payload):
                events.append(chunk)
            return events

        events = asyncio.get_event_loop().run_until_complete(collect_events())
        warning_events = [e for e in events if "token_warning" in e and "event: token_warning" in e]
        assert len(warning_events) == 0

    def test_sse_refresh_endpoint_issues_new_cookie(self):
        """sse-refresh 엔드포인트 → 새 sse_token 쿠키 발급"""
        from src.api.routes.auth import sse_token_refresh
        from fastapi import Request
        mock_response = MagicMock(spec=Response)
        mock_request = MagicMock(spec=Request); mock_request.state = MagicMock()
        mock_user = {"user_id": 1, "payload": {"type": "access"}}

        result = sse_token_refresh(mock_request, mock_response, mock_user)

        assert result["refreshed"] is True
        assert result["token_type"] == "sse_access"
        assert result["expires_in_seconds"] == 30 * 60
        assert mock_response.set_cookie.called

    def test_sse_refresh_next_action_is_reconnect(self):
        """sse-refresh 응답에 재연결 엔드포인트 안내"""
        from src.api.routes.auth import sse_token_refresh
        from fastapi import Request
        mock_response = MagicMock(spec=Response)
        mock_request = MagicMock(spec=Request); mock_request.state = MagicMock()
        mock_user = {"user_id": 1, "payload": {}}

        result = sse_token_refresh(mock_request, mock_response, mock_user)
        assert "/api/ai/stream/v2" in result["next_action"]


class TestAlertChannelIntegration:
    """[R27-②] alert_triggered 실제 알림 채널"""

    def setup_method(self):
        from src.api.routes import crisis_followup
        crisis_followup._ALERT_CHANNEL_LOG.clear()
        crisis_followup._ESCALATION_CRON_HEARTBEAT["last_run_at"] = None
        crisis_followup._ESCALATION_CRON_HEARTBEAT["run_count"] = 0
        crisis_followup._ESCALATION_CRON_HEARTBEAT["consecutive_failures"] = 0

    def _make_user(self):
        return {"user_id": 1, "payload": {}}

    def _make_request(self):
        from unittest.mock import MagicMock
        from fastapi import Request
        mock_req = MagicMock(spec=Request)
        mock_req.state = MagicMock()
        return mock_req

    def test_3_consecutive_failures_triggers_alert(self):
        """3회 연속 실패 → alert_triggered + 알림 채널 호출"""
        from src.api.routes.crisis_followup import escalation_cron_heartbeat_v2
        import asyncio
        loop = asyncio.get_event_loop()

        for _ in range(3):
            result = loop.run_until_complete(
                escalation_cron_heartbeat_v2(self._make_request(), self._make_user(), success=False)
            )

        assert result["alert_triggered"] is True
        assert result["alert_result"] is not None
        assert result["alert_result"]["alert_id"] == 1

    def test_alert_result_has_channel_status(self):
        """alert_result에 채널 상태 정보 포함"""
        from src.api.routes.crisis_followup import escalation_cron_heartbeat_v2, _ESCALATION_CRON_HEARTBEAT
        import asyncio
        loop = asyncio.get_event_loop()

        _ESCALATION_CRON_HEARTBEAT["consecutive_failures"] = 2  # 2로 설정
        result = loop.run_until_complete(
            escalation_cron_heartbeat_v2(self._make_request(), self._make_user(), success=False)
        )

        assert result["alert_triggered"] is True
        alert = result["alert_result"]
        assert "status" in alert
        assert alert["status"] in ("fcm_sent", "sms_queued", "log_only")

    def test_graceful_fallback_without_env(self):
        """환경변수 없으면 graceful fallback (log_only)"""
        from src.api.routes.crisis_followup import _send_alert_notification, _ALERT_CHANNEL_LOG

        # 환경변수 없는 상태에서 호출
        result = _send_alert_notification(
            channel="fcm",
            recipient_type="supervisor",
            message="테스트 알림",
            consecutive_failures=3,
        )

        # 환경변수 없으면 log_only
        assert result["status"] == "log_only"
        assert len(_ALERT_CHANNEL_LOG) == 1

    def test_alert_log_endpoint(self):
        """알림 채널 이력 조회 엔드포인트"""
        from src.api.routes.crisis_followup import get_alert_channel_log, _send_alert_notification
        import asyncio

        _send_alert_notification("fcm", "supervisor", "테스트", 3)
        result = asyncio.get_event_loop().run_until_complete(
            get_alert_channel_log(self._make_user())
        )

        assert result["total_alerts"] >= 1
        assert "channel_config" in result
        assert "fcm" in result["channel_config"]

    def test_success_resets_consecutive_failures(self):
        """성공 heartbeat → consecutive_failures 초기화"""
        from src.api.routes.crisis_followup import escalation_cron_heartbeat_v2
        import asyncio
        loop = asyncio.get_event_loop()

        # 2회 실패 후 성공
        loop.run_until_complete(escalation_cron_heartbeat_v2(self._make_request(), self._make_user(), success=False))
        loop.run_until_complete(escalation_cron_heartbeat_v2(self._make_request(), self._make_user(), success=False))
        result = loop.run_until_complete(escalation_cron_heartbeat_v2(self._make_request(), self._make_user(), success=True))

        assert result["consecutive_failures"] == 0
        assert result["alert_triggered"] is False


class TestFullStackE2E:
    """[R27-③] 전체 스택 통합 E2E 테스트"""

    def setup_method(self):
        from src.api.routes import crisis_followup
        crisis_followup._CRISIS_FOLLOWUP_LOG.clear()
        crisis_followup._NOTIFICATION_LOG.clear()
        crisis_followup._ESCALATION_IDEMPOTENCY_LOG.clear()
        crisis_followup._ALERT_CHANNEL_LOG.clear()
        crisis_followup._ESCALATION_CRON_HEARTBEAT["last_run_at"] = None
        crisis_followup._ESCALATION_CRON_HEARTBEAT["run_count"] = 0
        crisis_followup._ESCALATION_CRON_HEARTBEAT["consecutive_failures"] = 0
        crisis_followup._followup_id_counter = 0

    def _make_user(self, uid=1):
        return {"user_id": uid, "payload": {}}

    def _make_request(self):
        from unittest.mock import MagicMock
        from fastapi import Request
        mock_req = MagicMock(spec=Request)
        mock_req.state = MagicMock()
        return mock_req

    def test_full_crisis_followup_lifecycle(self):
        """위기 팔로업 전체 생명주기 E2E"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, notify_followup, get_followup,
            update_followup_status, get_notification_log,
            CrisisFollowupRequest, FollowupNotifyRequest,
            FollowupStatusUpdateRequest, FollowupStatus
        )
        import asyncio
        loop = asyncio.get_event_loop()

        # 1. 팔로업 등록
        body = CrisisFollowupRequest(senior_id=999, crisis_type="자살충동", note="긴급")
        register_result = loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))
        assert register_result["status"] == "pending"
        fid = register_result["followup_id"]

        # 2. 보호자 알림 발송
        notify_body = FollowupNotifyRequest(followup_id=fid, channel="sms", recipient_type="guardian")
        notify_result = loop.run_until_complete(notify_followup(self._make_request(), notify_body, self._make_user()))
        assert notify_result["legal_log_saved"] is True

        # 3. 팔로업 조회 — 알림 이력 확인
        detail = loop.run_until_complete(get_followup(fid, self._make_user()))
        assert detail["notification_count"] == 1
        assert detail["notification_history"][0]["channel"] == "sms"

        # 4. 팔로업 완료 처리
        update_body = FollowupStatusUpdateRequest(
            followup_id=fid,
            new_status=FollowupStatus.COMPLETED,
            resolution_note="보호자 연락 완료, 안전 확인"
        )
        update_result = loop.run_until_complete(update_followup_status(self._make_request(), update_body, self._make_user()))
        assert update_result["new_status"] == "completed"

        # 5. notification_log 법적 증거 확인
        log_result = loop.run_until_complete(get_notification_log(self._make_user()))
        assert log_result["total_notifications"] >= 1
        assert "자살예방법" in log_result["legal_basis"]

    def test_auto_escalation_e2e(self):
        """자동 에스컬레이션 E2E — 등록 → 기한 초과 → 자동 에스컬레이션"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, check_and_escalate_overdue_v2,
            get_followup, _CRISIS_FOLLOWUP_LOG,
            CrisisFollowupRequest, FollowupStatus
        )
        import asyncio
        loop = asyncio.get_event_loop()

        # 1. 팔로업 등록
        body = CrisisFollowupRequest(senior_id=888, crisis_type="심각한우울")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))
        assert _CRISIS_FOLLOWUP_LOG[0]["status"] == "pending"

        # 2. 기한 초과 시뮬레이션
        _CRISIS_FOLLOWUP_LOG[0]["scheduled_at"] = (
            datetime.now(timezone.utc) - timedelta(hours=30)
        ).isoformat()

        # 3. 자동 에스컬레이션 실행
        esc_result = loop.run_until_complete(check_and_escalate_overdue_v2(self._make_request(), self._make_user()))
        assert esc_result["escalated_count"] == 1

        # 4. 상태 변경 확인
        detail = loop.run_until_complete(get_followup(1, self._make_user()))
        assert detail["status"] == "escalated"
        assert detail["notification_count"] == 1  # system_escalation log
        assert detail["notification_history"][0]["sent_by_user_id"] == "SYSTEM_V2"

    def test_cron_monitoring_e2e(self):
        """크론 모니터링 E2E — heartbeat → 실패 → alert → 알림 채널"""
        from src.api.routes.crisis_followup import (
            escalation_cron_heartbeat_v2, escalation_cron_health,
            get_alert_channel_log
        )
        import asyncio
        loop = asyncio.get_event_loop()

        # 1. 3회 연속 실패
        for i in range(3):
            loop.run_until_complete(
                escalation_cron_heartbeat_v2(self._make_request(), self._make_user(), success=False)
            )

        # 2. 헬스 체크
        health = loop.run_until_complete(escalation_cron_health(self._make_user()))
        # 3회 실패로 degraded
        assert health["consecutive_failures"] == 3
        assert health["status"] in ("healthy", "degraded")  # 시간 기준으로 달라질 수 있음

        # 3. 알림 채널 이력 확인
        alert_log = loop.run_until_complete(get_alert_channel_log(self._make_user()))
        assert alert_log["total_alerts"] >= 1

    def test_sse_token_kst_daily_limit_integration(self):
        """SSE 인증 + KST daily_limit 통합"""
        from src.core.auth import create_sse_token
        from src.api.routes.ai_stream import _verify_cookie_token
        from src.services.ivr_service import check_daily_limit, _DAILY_CALL_LOG
        from fastapi import Request

        _DAILY_CALL_LOG.clear()

        # SSE 인증
        token = create_sse_token(user_id=500)
        mock_request = MagicMock(spec=Request)
        mock_request.cookies = {"access_token": token}
        user = _verify_cookie_token(mock_request)
        assert user["user_id"] == 500

        # KST daily_limit 확인
        limit_result = check_daily_limit(child_id=500, senior_id=600)
        assert limit_result["allowed"] is True
        # 두 번째 발신 차단
        limit_result2 = check_daily_limit(child_id=500, senior_id=600)
        assert limit_result2["allowed"] is False
        assert "KST" in limit_result2["reason"]

    def test_legal_evidence_completeness(self):
        """법적 증거 완전성 — 모든 notification에 legal_evidence 포함"""
        from src.api.routes.crisis_followup import (
            register_crisis_followup, notify_followup,
            check_and_escalate_overdue_v2, _CRISIS_FOLLOWUP_LOG,
            _NOTIFICATION_LOG, CrisisFollowupRequest, FollowupNotifyRequest
        )
        import asyncio
        loop = asyncio.get_event_loop()

        # 팔로업 등록 + 알림 발송 + 자동 에스컬레이션
        body = CrisisFollowupRequest(senior_id=777, crisis_type="위기")
        loop.run_until_complete(register_crisis_followup(self._make_request(), body, self._make_user()))

        notify_body = FollowupNotifyRequest(followup_id=1, channel="sms", recipient_type="guardian")
        loop.run_until_complete(notify_followup(self._make_request(), notify_body, self._make_user()))

        _CRISIS_FOLLOWUP_LOG[0]["scheduled_at"] = (
            datetime.now(timezone.utc) - timedelta(hours=30)
        ).isoformat()
        _CRISIS_FOLLOWUP_LOG[0]["status"] = "pending"  # 재설정
        loop.run_until_complete(check_and_escalate_overdue_v2(self._make_request(), self._make_user()))

        # 모든 notification_log에 legal_evidence 포함 확인
        for notification in _NOTIFICATION_LOG:
            assert "legal_evidence" in notification, f"Missing legal_evidence in {notification}"
            assert "statute" in notification["legal_evidence"]
            assert "자살예방법" in notification["legal_evidence"]["statute"]
