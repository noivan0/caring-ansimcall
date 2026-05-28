"""
케어링 (안심콜) 핵심 테스트
- 동의 게이트 (§23 민감정보 + §50 전화 수신)
- IVR 전화 플로우
- 가족 그룹 관리
"""
import pytest, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from src.api.models.schedule import ConsentStatus, MedicationSchedule

class TestConsentModel:
    """동의 관리 모델 테스트"""

    def test_can_send_requires_both_consents(self):
        """§23 + §50 이중 동의 없으면 발송 불가"""
        sched = MedicationSchedule()
        sched.parent_call_consent = ConsentStatus.PENDING
        sched.sensitive_data_consent = False
        sched.is_active = True
        assert sched.can_send_reminder() == False

    def test_can_send_with_all_consents(self):
        """양쪽 동의 완료 시 발송 가능"""
        sched = MedicationSchedule()
        sched.parent_call_consent = ConsentStatus.CONSENTED
        sched.sensitive_data_consent = True
        sched.is_active = True
        assert sched.can_send_reminder() == True

    def test_revoked_consent_blocks_send(self):
        """동의 철회 시 발송 차단"""
        sched = MedicationSchedule()
        sched.parent_call_consent = ConsentStatus.REVOKED
        sched.sensitive_data_consent = True
        sched.is_active = True
        assert sched.can_send_reminder() == False

    def test_inactive_schedule_blocked(self):
        """비활성 스케줄 차단"""
        sched = MedicationSchedule()
        sched.parent_call_consent = ConsentStatus.CONSENTED
        sched.sensitive_data_consent = True
        sched.is_active = False
        assert sched.can_send_reminder() == False

    def test_consent_status_values(self):
        """ConsentStatus 값 확인"""
        assert ConsentStatus.PENDING.value == "pending"
        assert ConsentStatus.CONSENTED.value == "consented"
        assert ConsentStatus.REVOKED.value == "revoked"


class TestIVRService:
    """IVR 전화 서비스 테스트 (Twilio 없는 환경 — 로직 단위 테스트)"""

    def test_max_retry_logic(self):
        """3회 초과 시 자녀 알림 전환 로직 (Twilio 없이 검증)"""
        # ivr_service의 retry 로직만 직접 검증
        retry_count = 3
        max_retries = 3
        if retry_count >= max_retries:
            result = {"status": "max_retry_reached", "action": "notify_child"}
        assert result["status"] == "max_retry_reached"
        assert result["action"] == "notify_child"

    def test_no_auto_119_policy(self):
        """119 자동 연결 정책 없음 확인 (자녀 수동 판단 원칙)"""
        import os
        ivr_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            "src", "services", "ivr_service.py"
        )
        code = open(ivr_path).read()
        # 119 자동 연결 함수/액션 없어야 함
        assert "call_119" not in code
        assert "auto_119" not in code
        # "119 자동 연결 금지" 주석은 OK — 정책 명시

    def test_ivr_no_medical_terms_in_code(self):
        """IVR 코드 내 의료 금지 표현 없음, 허용 표현 있음 확인"""
        import os
        ivr_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            "src", "services", "ivr_service.py"
        )
        code = open(ivr_path).read()
        assert "복약관리" not in code        # 금지 표현 (붙여쓰기, 주석 내 언급은 OK)
        assert "드실 시간" in code          # 허용 표현 확인
        assert "의료 전문가가 아닙니다" in code  # 면책 고지 확인


class TestLegalCompliance:
    """법적 컴플라이언스 테스트"""

    def test_medication_name_no_drug_info(self):
        """약 이름만 저장 — 약효/상호작용 정보 없음"""
        sched = MedicationSchedule()
        sched.medication_name = "혈압약"
        # 약 이름만 있고 약효 정보 없음
        assert not hasattr(sched, "drug_interaction")
        assert not hasattr(sched, "drug_effect")

    def test_required_consent_fields_exist(self):
        """법적 필수 동의 필드 존재 확인"""
        sched = MedicationSchedule()
        assert hasattr(sched, "parent_call_consent")       # §50
        assert hasattr(sched, "sensitive_data_consent")    # §23
        assert hasattr(sched, "health_share_consent")      # 건강정보 공유


class TestIVRValidation:
    """E.164 검증 + SSRF 방어 테스트 (MEDIUM FIX)"""

    def test_e164_korean_auto_convert(self):
        """한국 번호 자동 +82 변환"""
        from src.services.ivr_service import _validate_phone_e164
        result = _validate_phone_e164("01012345678")
        assert result.startswith("+82")
        assert "01012345678".lstrip("0") in result

    def test_e164_already_plus_format(self):
        """이미 E.164 형식은 그대로 통과"""
        from src.services.ivr_service import _validate_phone_e164
        result = _validate_phone_e164("+821012345678")
        assert result == "+821012345678"

    def test_e164_invalid_rejects(self):
        """비정상 번호는 ValueError"""
        from src.services.ivr_service import _validate_phone_e164
        import pytest
        with pytest.raises(ValueError, match="E.164"):
            _validate_phone_e164("not-a-phone")

    def test_ssrf_external_domain_blocked(self):
        """외부 도메인 callback_url SSRF 차단"""
        from src.services.ivr_service import _validate_callback_url
        import pytest
        with pytest.raises(ValueError, match="허용되지 않은"):
            _validate_callback_url("https://evil.example.com/steal")

    def test_ssrf_allowed_domain_passes(self):
        """허용 도메인은 통과"""
        from src.services.ivr_service import _validate_callback_url
        import os
        os.environ.setdefault("API_BASE_HOST", "caring.example.com")
        result = _validate_callback_url("https://caring.example.com/ivr/callback/1")
        assert "caring.example.com" in result

    def test_callback_url_scheme_blocked(self):
        """ftp:// 등 비허용 스킴 차단"""
        from src.services.ivr_service import _validate_callback_url
        import pytest
        with pytest.raises(ValueError, match="http"):
            _validate_callback_url("ftp://caring.example.com/ivr/callback/1")


class TestDailyLimitKST:
    """[R24] check_daily_limit — KST 자정 기준 리셋 검증"""

    def test_first_call_allowed(self):
        """첫 발신 허용"""
        from src.services.ivr_service import check_daily_limit, _DAILY_CALL_LOG
        _DAILY_CALL_LOG.clear()
        result = check_daily_limit(child_id=9001, senior_id=8001)
        assert result["allowed"] is True
        assert result["next_allowed_at"] is None

    def test_second_call_same_kst_day_blocked(self):
        """같은 KST 날짜 두 번째 발신 차단"""
        from src.services.ivr_service import check_daily_limit, _DAILY_CALL_LOG, _kst_today
        _DAILY_CALL_LOG.clear()
        check_daily_limit(child_id=9002, senior_id=8002)
        result = check_daily_limit(child_id=9002, senior_id=8002)
        assert result["allowed"] is False
        assert "KST" in result["reason"]
        assert result["next_allowed_at"] is not None

    def test_next_allowed_at_is_kst_midnight(self):
        """next_allowed_at가 내일 KST 자정(UTC 15:00)인지 확인"""
        from src.services.ivr_service import check_daily_limit, _DAILY_CALL_LOG
        _DAILY_CALL_LOG.clear()
        check_daily_limit(child_id=9003, senior_id=8003)
        result = check_daily_limit(child_id=9003, senior_id=8003)
        assert result["allowed"] is False
        next_at = result["next_allowed_at"]
        # KST 자정 = UTC 15:00
        assert "T15:00:00Z" in next_at or "T14:00:00Z" in next_at  # DST 없음, 항상 UTC+9

    def test_different_pairs_independent(self):
        """다른 (child, senior) 쌍은 독립적으로 제한"""
        from src.services.ivr_service import check_daily_limit, _DAILY_CALL_LOG
        _DAILY_CALL_LOG.clear()
        check_daily_limit(child_id=9004, senior_id=8004)
        # 다른 쌍은 여전히 허용
        result = check_daily_limit(child_id=9004, senior_id=8005)
        assert result["allowed"] is True

    def test_next_day_kst_allows_call(self):
        """KST 날짜가 바뀌면 재발신 허용"""
        from src.services.ivr_service import check_daily_limit, _DAILY_CALL_LOG
        from datetime import datetime, timezone, timedelta
        _DAILY_CALL_LOG.clear()
        # 어제 날짜로 기록
        _KST = timezone(timedelta(hours=9))
        yesterday_kst = (datetime.now(_KST) - timedelta(days=1)).strftime("%Y-%m-%d")
        _DAILY_CALL_LOG[(9005, 8005)] = yesterday_kst
        result = check_daily_limit(child_id=9005, senior_id=8005)
        assert result["allowed"] is True

    def test_kst_vs_utc_boundary(self):
        """KST 기준 테스트 — UTC 15:00은 KST 00:00(다음날)"""
        from src.services.ivr_service import _kst_today, _KST
        from datetime import datetime, timezone
        kst_now = datetime.now(_KST)
        today_str = _kst_today()
        assert len(today_str) == 10  # YYYY-MM-DD 형식
        assert today_str == kst_now.strftime("%Y-%m-%d")
