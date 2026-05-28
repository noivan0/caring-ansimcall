# Review Readiness Dashboard — [R44] npm audit 보안 패치
생성: 2026-05-27 (nova-ship, t_713e024a)
프로젝트: senior-care-api @ /root/.hermes/projects/senior-care

## ✅ 릴리즈 게이트

| 항목 | 결과 | 비고 |
|------|------|------|
| npm audit HIGH/CRITICAL | ✅ 0건 | 이전 15건 → 현재 8건(moderate only) |
| npm audit moderate | ⚠️ 8건 | firebase-admin 하위 의존성 (breaking change 필요) |
| 테스트 통과 | ✅ 415/415 pass | 18 suites, 0 fail |
| 코드 커버리지 | ⚠️ 57.32% | 목표 80% 미달 (pre-existing, AdherenceService 미커버) |
| SQL 인젝션 위험 | ✅ 없음 | 파라미터화 쿼리($1,$2) 사용, DDL-only exec() |
| 하드코딩 시크릿 | ✅ 없음 | process.env 기반 환경변수 |
| .catch() 누락 | ✅ 수정 완료 | emergencyService.js escalateEmergency() |
| IVR 오탐 패치 | ✅ 완료 | 한국어 includes() → Set+regex 앵커 |
| Dockerfile PORT | ✅ 통일 | 3001 → 8000 |
| GitHub PR | ⚠️ 미생성 | 로컬 리포 (remote 없음) |

## 🔒 보안 변경 이력 (commit 76c6246)
- aws-sdk: 완전 제거 (소스 미사용, HIGH 해소)
- bcrypt: 5.1.1 → 6.0.0 (tar HIGH 해소)
- uuid: 10 → 11.1.1 (HIGH 해소)
- firebase-admin, node-cron: 최신 버전
- emergencyService.js: .catch 누락 → try/catch 추가
- IvrService.js: 한국어 whitelist Set + regex 앵커 교체

## 📌 잔여 이슈
1. **npm audit moderate 8건** (firebase-admin/google-gax/teeny-request/retry-request)
   → firebase-admin을 10.x로 다운그레이드해야 해소 가능 (breaking change)
   → Action: 별도 태스크로 추적 권장
2. **커버리지 57.32%** (목표: 80%)
   → AdherenceService.js, db.js, HealthRecord.js 커버리지 0%
   → Action: 단위 테스트 추가 필요

## 📦 배포 준비 현황
- Local master branch: 최신 (commit 2f09204)
- Upstream: 없음 (local-only)
- 배포 전제 조건: GitHub remote 설정 + PR 생성

## Take
Take: "npm audit HIGH 제거는 가능해도, google-gax 등 transitive 의존성은
breaking change 없이 해소 불가 — 검토 없이 force fix 사용 금지"
