"""
P3: Twilio IVR Mock Stub — 실제 Twilio 없이 IVR 발신 전체 플로우 검증

nova-dev Sprint: Twilio IVR mock stub 구성 (P3)
- make_reminder_call() mock patch 기반 단위 테스트
- 발신 성공/실패/kill-switch/retry 분기 전부 커버
- TWILIO_* env 없는 CI 환경에서도 동작
"""
import os
import pytest
from unittest.mock import MagicMock, patch


# --- conftest에서 TWILIO env 없이도 임포트 가능한지 확인 ---
def test_ivr_service_importable_without_twilio():
    """Twilio 환경변수 없어도 ivr_service 임포트 정상"""
    from src.services.ivr_service import (
        make_reminder_call,
        build_reminder_twiml,
        get_ivr_kill_switch,
        set_ivr_kill_switch,
        handle_ivr_status_callback,
        check_daily_limit,
    )
    assert callable(make_reminder_call)
    assert callable(build_reminder_twiml)


# --- TwiML 생성 (Twilio SDK 의존, 실제 구조 검증) ---
def test_build_reminder_twiml_structure():
    """TwiML 생성 — Say/Gather 포함, 의료 금지 표현 없음"""
    from src.services.ivr_service import build_reminder_twiml
    twiml = build_reminder_twiml("혈압약", "https://caring.example.com/ivr/callback/1")
    assert "<Say" in twiml
    assert "<Gather" in twiml
    assert "드실 시간" in twiml
    assert "의료 전문가가 아닙니다" in twiml
    # 의료 금지 표현 없음
    assert "복약관리" not in twiml


def test_build_reminder_twiml_sanitize_xss():
    """med_name XSS/XML 인젝션 sanitize"""
    from src.services.ivr_service import build_reminder_twiml
    twiml = build_reminder_twiml(
        "<script>alert(1)</script>",
        "https://caring.example.com/ivr/callback/1",
    )
    # XSS 코드가 그대로 남으면 안 됨 — Twilio SDK가 XML escape하거나 제거됨
    # sanitize 결과 safe_med_name="scriptalert1/script" or "" → 폴백 "약"
    assert "<script>" not in twiml


# --- make_reminder_call mock 패치 ---
class MockCall:
    sid = "CA_MOCK_TEST_12345678"


@patch("src.services.ivr_service.TWILIO_SID", "ACtest123")
@patch("src.services.ivr_service.TWILIO_TOKEN", "authtoken456")
@patch("src.services.ivr_service.TWILIO_FROM", "+820000000000")
def test_make_reminder_call_success():
    """정상 발신 — mock Client 사용, call.sid 반환 확인
    Client는 함수 내 lazy import이므로 twilio.rest.Client 패치 사용.
    """
    from src.services.ivr_service import make_reminder_call
    with patch("twilio.rest.Client") as MockClient:
        mock_client_instance = MagicMock()
        MockClient.return_value = mock_client_instance
        mock_client_instance.calls.create.return_value = MockCall()

        result = make_reminder_call(
            parent_phone="+821012345678",
            med_name="혈압약",
            callback_url="https://caring.example.com/ivr/callback/1",
        )

    assert result["status"] == "initiated"
    assert result["call_sid"] == "CA_MOCK_TEST_12345678"
    assert result["med_name"] == "혈압약"
    assert result["retry_count"] == 0


@patch("src.services.ivr_service.TWILIO_SID", "ACtest123")
@patch("src.services.ivr_service.TWILIO_TOKEN", "authtoken456")
@patch("src.services.ivr_service.TWILIO_FROM", "+820000000000")
def test_make_reminder_call_twilio_exception():
    """Twilio 예외 발생 → call_failed, notify_child fallback"""
    from src.services.ivr_service import make_reminder_call
    with patch("twilio.rest.Client") as MockClient:
        mock_client_instance = MagicMock()
        MockClient.return_value = mock_client_instance
        mock_client_instance.calls.create.side_effect = Exception("Twilio 연결 실패")

        result = make_reminder_call(
            parent_phone="+821012345678",
            med_name="혈압약",
            callback_url="https://caring.example.com/ivr/callback/1",
        )

    assert result["status"] == "call_failed"
    assert result["action"] == "notify_child"


def test_make_reminder_call_no_twilio_config():
    """TWILIO_SID 없으면 twilio_not_configured 반환 (서버 기동 영향 없음)"""
    from src.services.ivr_service import make_reminder_call
    with patch("src.services.ivr_service.TWILIO_SID", ""):
        result = make_reminder_call(
            parent_phone="+821012345678",
            med_name="혈압약",
            callback_url="https://caring.example.com/ivr/callback/1",
        )
    assert result["status"] == "twilio_not_configured"


def test_make_reminder_call_max_retry():
    """retry_count >= 3 → max_retry_reached (Twilio 호출 없이)"""
    from src.services.ivr_service import make_reminder_call
    result = make_reminder_call(
        parent_phone="+821012345678",
        med_name="혈압약",
        callback_url="https://caring.example.com/ivr/callback/1",
        retry_count=3,
    )
    assert result["status"] == "max_retry_reached"
    assert result["action"] == "notify_child"


@patch("src.services.ivr_service.TWILIO_SID", "ACtest123")
@patch("src.services.ivr_service.TWILIO_TOKEN", "authtoken456")
@patch("src.services.ivr_service.TWILIO_FROM", "+820000000000")
def test_make_reminder_call_kill_switch():
    """IVR kill-switch 활성 → blocked (Twilio 호출 없이)"""
    from src.services.ivr_service import make_reminder_call, set_ivr_kill_switch
    set_ivr_kill_switch(True)
    try:
        result = make_reminder_call(
            parent_phone="+821012345678",
            med_name="혈압약",
            callback_url="https://caring.example.com/ivr/callback/1",
        )
        assert result["status"] == "blocked"
        assert result["action"] == "notify_child"
    finally:
        set_ivr_kill_switch(False)  # 항상 복원


def test_make_reminder_call_invalid_phone():
    """비정상 전화번호 → invalid_input (Twilio 호출 없이)"""
    from src.services.ivr_service import make_reminder_call
    with patch("src.services.ivr_service.TWILIO_SID", "ACtest"):
        with patch("src.services.ivr_service.TWILIO_TOKEN", "tok"):
            with patch("src.services.ivr_service.TWILIO_FROM", "+820000"):
                result = make_reminder_call(
                    parent_phone="not-a-phone",
                    med_name="혈압약",
                    callback_url="https://caring.example.com/ivr/callback/1",
                )
    assert result["status"] == "invalid_input"


# --- IVR 상태 콜백 처리 ---
def test_handle_ivr_status_callback_no_answer():
    """no-answer → should_retry=True (초기 시도)"""
    from src.services.ivr_service import handle_ivr_status_callback
    result = handle_ivr_status_callback("CA123", "no-answer", retry_count=0)
    assert result["should_retry"] is True
    assert result["escalate_to"] is None


def test_handle_ivr_status_callback_max_retry():
    """no-answer 3회 소진 → escalate_to child"""
    from src.services.ivr_service import handle_ivr_status_callback
    result = handle_ivr_status_callback("CA123", "no-answer", retry_count=3)
    assert result["should_retry"] is False
    assert result["escalate_to"] == "child_push_notification"


def test_handle_ivr_status_callback_completed():
    """completed → retry 없음"""
    from src.services.ivr_service import handle_ivr_status_callback
    result = handle_ivr_status_callback("CA123", "completed", retry_count=0)
    assert result["should_retry"] is False
    assert result["escalate_to"] is None


# --- 일일 발신 제한 ---
def test_check_daily_limit_first_call():
    """첫 발신은 허용"""
    from src.services.ivr_service import check_daily_limit, _DAILY_CALL_LOG
    # 독립 키 사용 (다른 테스트 간 간섭 방지)
    _DAILY_CALL_LOG.clear()
    result = check_daily_limit(child_id=9001, senior_id=9002)
    assert result["allowed"] is True


def test_check_daily_limit_second_call_blocked():
    """같은 날 두 번째 발신 → 차단"""
    from src.services.ivr_service import check_daily_limit, _DAILY_CALL_LOG
    _DAILY_CALL_LOG.clear()
    check_daily_limit(child_id=8001, senior_id=8002)  # 첫 발신
    result = check_daily_limit(child_id=8001, senior_id=8002)  # 두 번째
    assert result["allowed"] is False
    assert "next_allowed_at" in result
