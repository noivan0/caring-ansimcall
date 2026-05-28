"""
slowapi Limiter 공유 모듈 — 순환 임포트 방지를 위해 main.py와 분리.
main.py와 routes 파일 양쪽에서 동일 인스턴스 사용.

테스트 환경: RATELIMIT_ENABLED=False 로 비활성화.
"""
import os
from slowapi import Limiter
from slowapi.util import get_remote_address

_enabled = os.getenv("RATELIMIT_ENABLED", "True").lower() not in ("false", "0", "no")

limiter = Limiter(key_func=get_remote_address, enabled=_enabled)
