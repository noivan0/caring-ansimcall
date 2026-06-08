"""
Tests: FastAPI /health/live + /health/ready 프로브 엔드포인트

테스트 대상:
  GET /health/live  — 항상 200, {"status": "alive"}
  GET /health/ready — DB + Redis 연결 성공 시 200, 실패 시 503
"""
import os
import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from fastapi.testclient import TestClient

# conftest.py에서 환경변수 설정됨
from src.api.main import app

client = TestClient(app)


class TestHealthLive:
    """GET /health/live — Liveness probe"""

    def test_returns_200(self):
        res = client.get("/health/live")
        assert res.status_code == 200

    def test_returns_alive_status(self):
        res = client.get("/health/live")
        assert res.json()["status"] == "alive"

    def test_returns_service_name(self):
        res = client.get("/health/live")
        assert res.json()["service"] == "caring-api"

    def test_alive_even_when_db_down(self):
        """DB 연결 실패가 liveness에 영향 없음"""
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://bad:***@nowhere:5432/nodb"}):
            # liveness는 DB를 체크하지 않으므로 항상 200
            res = client.get("/health/live")
        assert res.status_code == 200
        assert res.json()["status"] == "alive"


def _make_mock_engine():
    """DB 연결 성공 mock 헬퍼"""
    mock_conn = MagicMock()
    mock_conn.__enter__ = MagicMock(return_value=mock_conn)
    mock_conn.__exit__ = MagicMock(return_value=False)
    mock_engine = MagicMock()
    mock_engine.connect.return_value = mock_conn
    return mock_engine


class TestHealthReady:
    """GET /health/ready — Readiness probe"""

    def test_ready_without_db_url(self):
        """DATABASE_URL 없으면 db=skipped 로 200 ready"""
        import src.api.main as main_module
        saved_engine = main_module._db_engine
        saved_redis = main_module._redis_pool
        # 싱글톤을 None으로 설정하고 DATABASE_URL 환경변수도 제거
        main_module._db_engine = None
        main_module._redis_pool = None
        saved_url = os.environ.pop("DATABASE_URL", None)
        saved_redis_url = os.environ.pop("REDIS_URL", None)
        try:
            res = client.get("/health/ready")
            assert res.status_code == 200
            assert res.json()["status"] == "ready"
            assert res.json()["db"] == "skipped"
        finally:
            main_module._db_engine = saved_engine
            main_module._redis_pool = saved_redis
            if saved_url is not None:
                os.environ["DATABASE_URL"] = saved_url
            if saved_redis_url is not None:
                os.environ["REDIS_URL"] = saved_redis_url

    def test_ready_with_mocked_db_ok(self):
        """DB 연결 성공 시 200 ready + db=ok"""
        import src.api.main as main_module
        mock_engine = _make_mock_engine()

        # Redis도 성공 mock (async event loop 이슈 방지)
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(return_value=True)
        saved_engine = main_module._db_engine
        saved_pool = main_module._redis_pool
        main_module._db_engine = mock_engine
        main_module._redis_pool = mock_redis
        try:
            res = client.get("/health/ready")
        finally:
            main_module._db_engine = saved_engine
            main_module._redis_pool = saved_pool

        assert res.status_code == 200
        assert res.json()["status"] == "ready"
        assert res.json()["db"] == "ok"

    def test_not_ready_when_db_fails(self):
        """DB 연결 실패 시 503 not_ready + db=error"""
        import src.api.main as main_module
        mock_engine = MagicMock()
        mock_engine.connect.side_effect = Exception("DB 연결 실패")
        saved_engine = main_module._db_engine
        saved_pool = main_module._redis_pool
        main_module._db_engine = mock_engine
        main_module._redis_pool = None
        saved_redis_url = os.environ.pop("REDIS_URL", None)
        try:
            res = client.get("/health/ready")
            assert res.status_code == 503
            assert res.json()["status"] == "not_ready"
            assert res.json()["db"] == "error"
        finally:
            main_module._db_engine = saved_engine
            main_module._redis_pool = saved_pool
            if saved_redis_url is not None:
                os.environ["REDIS_URL"] = saved_redis_url

    def test_returns_service_name(self):
        """응답에 service 필드 포함"""
        res = client.get("/health/ready")
        assert res.json()["service"] == "caring-api"

    def test_create_engine_called_once(self):
        """create_engine이 앱 수명 동안 1회만 호출됨을 확인 (STRIDE-D-001)"""
        import src.api.main as main_module
        saved_engine = main_module._db_engine
        saved_redis = main_module._redis_pool
        mock_engine = _make_mock_engine()
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(return_value=True)
        main_module._redis_pool = mock_redis
        # 싱글톤 리셋 → _get_db_engine()이 create_engine 호출하게 함
        main_module._db_engine = None
        try:
            # DATABASE_URL을 명시적으로 설정해야 _get_db_engine() 내 create_engine 분기 진입
            with patch.dict(os.environ, {"DATABASE_URL": "postgresql://user:pass@localhost/testdb"}):
                with patch("sqlalchemy.create_engine", return_value=mock_engine) as mock_ce:
                    # 첫 번째 호출 → create_engine 1회 실행
                    res1 = client.get("/health/ready")
                    # 두 번째, 세 번째 호출 → 싱글톤 재사용, create_engine 추가 호출 없음
                    res2 = client.get("/health/ready")
                    res3 = client.get("/health/ready")
                    # create_engine은 앱 수명 중 딱 1회만 호출
                    assert mock_ce.call_count == 1
        finally:
            main_module._db_engine = saved_engine
            main_module._redis_pool = saved_redis

        assert res1.status_code == 200
        assert res2.status_code == 200
        assert res3.status_code == 200



class TestHealthReadyRedis:
    """GET /health/ready — Redis ping 체크"""

    def test_ready_without_redis_url(self):
        """REDIS_URL 없으면 redis=skipped 로 200 ready"""
        import src.api.main as main_module
        saved_pool = main_module._redis_pool
        saved_engine = main_module._db_engine
        main_module._redis_pool = None
        main_module._db_engine = _make_mock_engine()
        saved_url = os.environ.pop("REDIS_URL", None)
        try:
            res = client.get("/health/ready")
            assert res.status_code == 200
            assert res.json()["redis"] == "skipped"
        finally:
            main_module._redis_pool = saved_pool
            main_module._db_engine = saved_engine
            if saved_url is not None:
                os.environ["REDIS_URL"] = saved_url

    def test_ready_with_redis_ping_ok(self):
        """REDIS_URL 있고 ping 성공 시 redis=ok + 200"""
        import src.api.main as main_module
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(return_value=True)
        saved_pool = main_module._redis_pool
        saved_engine = main_module._db_engine
        main_module._redis_pool = mock_redis
        main_module._db_engine = _make_mock_engine()
        try:
            res = client.get("/health/ready")
            assert res.status_code == 200
            assert res.json()["redis"] == "ok"
        finally:
            main_module._redis_pool = saved_pool
            main_module._db_engine = saved_engine

    def test_not_ready_when_redis_ping_fails(self):
        """REDIS_URL 있고 ping 실패 시 redis=error + 503"""
        import src.api.main as main_module
        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(side_effect=Exception("Redis 연결 실패"))
        saved_pool = main_module._redis_pool
        saved_engine = main_module._db_engine
        main_module._redis_pool = mock_redis
        main_module._db_engine = _make_mock_engine()
        try:
            res = client.get("/health/ready")
            assert res.status_code == 503
            assert res.json()["redis"] == "error"
            assert res.json()["status"] == "not_ready"
        finally:
            main_module._redis_pool = saved_pool
            main_module._db_engine = saved_engine
