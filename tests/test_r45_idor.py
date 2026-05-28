"""
R23-EDGE-004: 케어링 IDOR 차단 테스트 (단위 테스트)
- update_consent: 타인 schedule_id → 403
- get_reminder_logs: 타인 schedule_id → 403
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("SECRET_KEY", "test-secret-key-caring-32chars-min")
os.environ.setdefault("REFRESH_SECRET_KEY", "test-refresh-secret-key-32chars-min")
os.environ.setdefault("DATABASE_URL", "")

import pytest
from unittest.mock import patch, MagicMock
from fastapi import HTTPException


class TestR23IDORUnit:
    """R23-EDGE-004: IDOR 차단 단위 검증"""

    def _make_user(self, user_id=1):
        return {"user_id": user_id, "role": "child"}

    def _full_consent(self, ok=True):
        from src.api.routes.schedules import ConsentUpdate
        return ConsentUpdate(
            parent_call_consent=ok,
            sensitive_data_consent=ok,
            health_share_consent=ok,
        )

    def _mock_db_session(self, schedule):
        mock_session = MagicMock()
        mock_session.__enter__ = lambda s: s
        mock_session.__exit__ = MagicMock(return_value=False)
        mock_session.get.return_value = schedule
        return mock_session

    # ── get_reminder_logs ──────────────────────────────────────
    def test_get_reminder_logs_no_db_ok(self):
        """DB 없으면 schedule=None → 소유권 skip → 정상 반환"""
        from src.api.routes.schedules import get_reminder_logs
        result = get_reminder_logs(1, self._make_user(1))
        assert result["schedule_id"] == 1

    def test_get_reminder_logs_other_403(self):
        """타인 스케줄 logs IDOR → 403"""
        from src.api.routes.schedules import get_reminder_logs
        mock_schedule = MagicMock()
        mock_schedule.child_user_id = 9999

        with patch("sqlalchemy.create_engine", return_value=MagicMock()), \
             patch("sqlalchemy.orm.sessionmaker",
                   return_value=MagicMock(return_value=self._mock_db_session(mock_schedule))), \
             patch.dict("os.environ", {"DATABASE_URL": "sqlite:///:memory:"}):
            with pytest.raises(HTTPException) as exc:
                get_reminder_logs(999, self._make_user(1))
            assert exc.value.status_code == 403

    def test_get_reminder_logs_own_ok(self):
        """자신의 스케줄 → 200"""
        from src.api.routes.schedules import get_reminder_logs
        mock_schedule = MagicMock()
        mock_schedule.child_user_id = 1  # 일치

        with patch("sqlalchemy.create_engine", return_value=MagicMock()), \
             patch("sqlalchemy.orm.sessionmaker",
                   return_value=MagicMock(return_value=self._mock_db_session(mock_schedule))), \
             patch.dict("os.environ", {"DATABASE_URL": "sqlite:///:memory:"}):
            result = get_reminder_logs(1, self._make_user(1))
        assert result["schedule_id"] == 1

    # ── update_consent ─────────────────────────────────────────
    def test_update_consent_insufficient_400(self):
        """필수 동의 미완료 → 400"""
        from src.api.routes.schedules import update_consent
        from fastapi import Request
        body = self._full_consent(ok=True)
        body.parent_call_consent = False  # 하나 False
        mock_req = MagicMock(spec=Request); mock_req.state = MagicMock()
        with pytest.raises(HTTPException) as exc:
            update_consent(mock_req, 1, body, self._make_user(1))
        assert exc.value.status_code == 400

    def test_update_consent_other_403(self):
        """타인 schedule update_consent IDOR → 403"""
        from src.api.routes.schedules import update_consent
        from fastapi import Request
        mock_schedule = MagicMock()
        mock_schedule.child_user_id = 9999
        body = self._full_consent()
        mock_req = MagicMock(spec=Request); mock_req.state = MagicMock()

        with patch("sqlalchemy.create_engine", return_value=MagicMock()), \
             patch("sqlalchemy.orm.sessionmaker",
                   return_value=MagicMock(return_value=self._mock_db_session(mock_schedule))), \
             patch.dict("os.environ", {"DATABASE_URL": "sqlite:///:memory:"}):
            with pytest.raises(HTTPException) as exc:
                update_consent(mock_req, 999, body, self._make_user(1))
            assert exc.value.status_code == 403

    def test_update_consent_own_ok(self):
        """자신의 schedule update_consent → 200"""
        from src.api.routes.schedules import update_consent
        from fastapi import Request
        mock_schedule = MagicMock()
        mock_schedule.child_user_id = 1
        body = self._full_consent()
        mock_req = MagicMock(spec=Request); mock_req.state = MagicMock()

        with patch("sqlalchemy.create_engine", return_value=MagicMock()), \
             patch("sqlalchemy.orm.sessionmaker",
                   return_value=MagicMock(return_value=self._mock_db_session(mock_schedule))), \
             patch.dict("os.environ", {"DATABASE_URL": "sqlite:///:memory:"}):
            result = update_consent(mock_req, 1, body, self._make_user(1))
        assert result["status"] == "consented"
