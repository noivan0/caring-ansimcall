# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [2026-05-27] K8s 헬스 프로브 패턴 통합 (nova-learn → nova-document)

### Added
- `GET /health/live` — K8s liveness probe 엔드포인트 (항상 200)
- `GET /health/ready` — K8s readiness probe (DB 연결 확인, 실패 시 503)
- `tests/test_health_probe.py` — 헬스 프로브 전체 시나리오 테스트 7개
- `docs/health-endpoint-guide-20260527.md` — 개발자/운영자/보안 3계층 Diataxis 가이드

### Improved
- `/health/ready` DB 연결에 `connect_timeout=3s` I/O 가드 적용 (Pattern 3, weight=0.85)
- `debug=False` 명시로 프로덕션 스택트레이스 외부 노출 차단

### Patterns (nova_brain.db 등록)
- Redis 연결풀 싱글톤 패턴 [weight=0.92 GOLD] — 매 요청 신규 연결 절대 금지
- 헬스 의존성 체크셋 통일 패턴 [weight=0.88 SILVER] — 마이크로서비스 전체 동일 체크셋
- 헬스체크 I/O timeout 가드 [weight=0.85 SILVER] — 모든 I/O에 1-2s timeout 필수

### Security Tracking
| ID | 심각도 | 상태 | 설명 |
|---|---|---|---|
| SEC-001 | MEDIUM | MITIGATED | 헬스 응답 에러 상세 노출 — `db=error` 최소 노출로 완화 |
| SEC-002 | LOW | MITIGATED | 헬스 프로브 DoS 가능성 — connect_timeout=3s 가드 적용 |

### DreamCycle 전파 예정
- nova-dev: FastAPI /health/ready Redis ping 추가 (P1)
- nova-qa: 헬스 비대칭 감사 체크리스트 (P1)
- nova-cso: timeout STRIDE 체크 (P2)

### Survivorship Bias 경계
K8s 고부하 미검증 — 스테이징 부하 테스트 후 GOLD 격상 가능

---

## [보안 이슈 추적 테이블]

| ID | 심각도 | 상태 | 설명 | 발견일 |
|---|---|---|---|---|
| SEC-001 | MEDIUM | MITIGATED | 헬스 에러 상세 노출 방지 | 2026-05-27 |
| SEC-002 | LOW | MITIGATED | 헬스 프로브 DoS 가드 | 2026-05-27 |
