"""
케어링 SMS OTP 인증 테스트
"""
import pytest
from unittest.mock import patch, MagicMock
from src.services.sms_service import send_otp, verify_otp, _otp_store, _otp_send_log


@pytest.fixture(autouse=True)
def clear_store():
    """각 테스트 전 스토어 초기화"""
    _otp_store.clear()
    _otp_send_log.clear()
    yield
    _otp_store.clear()
    _otp_send_log.clear()


def test_send_otp_success():
    """정상 OTP 발송"""
    with patch("src.services.sms_service._send_sms") as mock_sms:
        result = send_otp("+821012345678")
        assert result["sent"] is True
        assert result["expires_in"] == 300
        mock_sms.assert_called_once()


def test_send_otp_normalizes_korean_number():
    """한국 번호 E.164 자동 변환"""
    with patch("src.services.sms_service._send_sms"):
        result = send_otp("01012345678")
        assert result["sent"] is True


def test_send_otp_invalid_phone():
    """잘못된 전화번호 거부"""
    with pytest.raises(ValueError):
        send_otp("not-a-phone")


def test_verify_otp_success():
    """정상 OTP 검증"""
    with patch("src.services.sms_service._send_sms"):
        send_otp("+821012345678")
    phone_hash = list(_otp_store.keys())[0]
    otp = _otp_store[phone_hash]["otp"]
    assert verify_otp("+821012345678", otp) is True


def test_verify_otp_wrong_code():
    """틀린 OTP 거부"""
    with patch("src.services.sms_service._send_sms"):
        send_otp("+821012345678")
    assert verify_otp("+821012345678", "000000") is False


def test_verify_otp_expired():
    """만료된 OTP 거부"""
    with patch("src.services.sms_service._send_sms"):
        send_otp("+821012345678")
    phone_hash = list(_otp_store.keys())[0]
    _otp_store[phone_hash]["expires_at"] = 0  # 과거 시각으로 설정
    assert verify_otp("+821012345678", "123456") is False


def test_verify_otp_one_time_use():
    """OTP 재사용 불가"""
    with patch("src.services.sms_service._send_sms"):
        send_otp("+821012345678")
    phone_hash = list(_otp_store.keys())[0]
    otp = _otp_store[phone_hash]["otp"]
    assert verify_otp("+821012345678", otp) is True
    # 두 번째 시도 → 스토어에서 삭제됨
    assert verify_otp("+821012345678", otp) is False


def test_rate_limit():
    """1분 3회 초과 발송 차단"""
    with patch("src.services.sms_service._send_sms"):
        send_otp("+821012345678")
        send_otp("+821012345678")
        send_otp("+821012345678")
        with pytest.raises(ValueError, match="OTP 발송 횟수 초과"):
            send_otp("+821012345678")
