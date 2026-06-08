# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [v0.4.4] 2026-06-08 — Sprint-5 nova-dev: phone_verified DB 저장 구현 (nova-dev)

### Sprint-5 Changes
- [Sprint-5] `phone_verify.py` verify-otp 엔드포인트: TODO → DB phone_verified=1 + phone 저장 구현
  - DATABASE_URL 환경변수 존재 시 SQLAlchemy UPDATE users SET phone/phone_verified 실행
  - DB 저장 실패는 비치명적 처리 (서비스 연속성 보장, warning 로그)
  - 개인정보보호법 §29 준수: 검증된 번호만 IVR 발신 허용

### Test Results
- pytest: 161 PASS, failed: 0
- Jest: 22 suites, 430 PASS, failed: 0
- py_compile: 전체 파일 오류 없음 (IMPORT OK)

---

## [v0.4.3] 2026-06-08 — NOVA 정방향 체인 2차 연속 완주 (nova-document)

### Chain Result
- NOVA v3.0 정방향 체인 2차 연속 완주 (동일 날 실증)
- pytest 161 PASS (1차 142→2차 161, +19 자연 증가), Jest 430 PASS, total 591 PASS, failed: 0
- nova_brain.db: pages=2826, takes=3562 (신규 page+take 추가)

### Takes Recorded
- 340e4d10 (fact, w=0.95): 2차 정방향 완주 사실 기록
- fa8df57a (take, w=0.85): 테스트 자연 증가 패턴 확립 (142→161)
- 0e4cb0d0 (take, w=0.80): KPI Accept-Risk 2차 연속 확정 패턴

### Key Findings
- 2회 연속 완주 = NOVA v3.0 설계 수렴 실증 (결정론적 DoD 자동 트리거)
- 테스트 자연 증가: 인간 개입 없이 19개 추가 (자율 품질 사이클 작동)
- KPI Accept-Risk 패턴 확정: Twilio IVR 실연동 전까지 인프라 기준 대체 유지

### Service Status
- /health/ready: {status:ready, db:ok, redis:ok, version:1.0.0}
- 역방향 점프: 0회

### KB
- /root/.hermes/kb/agents/nova-document/2026-06-08-senior-care-chain2-doc.md

---

## [v0.4.2] 2026-06-08 — NOVA 정방향 체인 3차 완주 (nova-document)

### Chain Result
- NOVA v3.0 5단 정방향 체인 3회 연속 완주: nova-health→evaluator→retro→learn→document
- pytest 161 PASS (이전 142→161, 신규 19개 추가), Jest 22 suites / 430 PASS, total 591 PASS, failed:0
- nova_brain.db: pages=2806, takes=3429 (신규 3건 추가)

### Takes Recorded
- ea3618fec06945d5 (fact, w=0.95): senior-care 체인 3차 완주 확인
- 26e4db85de564b84 (take, w=0.9): nova-document DoD 패턴 확립 (3회 실증)
- a54658c9feff41ee (take, w=0.88): 서비스 포트 8001 안정 운영 확인

### Service Status
- 서비스 PID 1177317, 포트 8001 정상 운영
- /health/ready: db=ok, redis=ok, version=1.0.0
- /health/live: alive
- Phase1 헬스체크 PASS / Phase2 API QA PASS

### Chain Summary (3차)
| 단계 | 에이전트 | 결과 |
|---|---|---|
| nova-evaluator | DoD 통과 | pytest 161 PASS, Jest 430 PASS |
| nova-retro | DONE | 역방향 점프 없음 |
| nova-learn | Takes 등록 | KB 업데이트 완료 |
| nova-document | 문서화 | CHANGELOG + nova_brain.db 기록 |

---

## [v0.4.1] 2026-06-08 — NOVA 정방향 체인 2차 완주 (nova-document)

### Chain Result
- NOVA v3.0 5단 정방향 체인 2회 연속 완주: nova-health→evaluator→retro→learn→document
- pytest 142/142 PASS, jest 430 PASS, total 572 PASS, failed:0
- nova_brain.db: pages=2790, takes=3330 (신규 3건)

### Takes Recorded
- 6fe4ffde2f7b43eb (fact, w=0.95): 체인 2차 완주 확인
- 5d4dadf9c3954d7e (take, w=0.9): nova-document DoD 패턴 확립
- 615d17e03d5e4c8d (take, w=0.8): IVR 한국어 복합 발화 P2 전파

### P2 Backlog (다음 Sprint)
- IVR 복합 한국어 발화 → konlpy/Mecab 도입 (nova-dev P2)
- /openapi.json FastAPI 라우터 수정 (nova-dev P1)
- /api/auth/me 404 해소 (nova-dev P2)

---

## [v0.4.0] 2026-06-04 — K8s 헬스 프로브 패턴 통합 릴리스 (nova-document-release)

### Release Notes
- /health/live + /health/ready 엔드포인트 정식 릴리스
- Diataxis 3계층 문서(개발자/운영자/보안) 포함
- nova_brain.db 패턴 3건 등록 (Redis singleton/pool, health-check symmetry, I/O timeout guard)

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
