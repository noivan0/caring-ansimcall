# 케어링 (Senior Care) — NOVA Harness

## 목표
부모님 복약/건강 알림 서비스 — 자녀-부모님 양측 동의 기반 IVR 자동 전화

## 아키텍처
- Node.js (Express) + Python (FastAPI) 혼합
- Twilio IVR + SMS OTP 인증
- Redis OTP store / SQLite DB

## 포트 & 엔드포인트
- 포트: 8001 (헬스: GET /ping)
- 주요 API: /api/auth/phone/* / /api/family/invite/* / /api/ivr/*

## 테스트
- Jest: 430 PASS (Node.js 라우터, 22 suites)
- pytest: 142 PASS (Python FastAPI)
- 전체: 572 PASS

### canonical QA commands (repo root)
- Node.js: `npm test -- --runInBand`
- Python: `python3 -m pytest -q`

주의: Python 하네스는 console-script `pytest -q`가 아니라
module invocation `python3 -m pytest -q`를 기준 명령으로 사용한다.

## 보안 패치 이력
- R8: SSRF callback_url 화이트리스트
- R13: SecurityHeadersMiddleware (CSP/HSTS/X-Frame)
- R15: KR_MOBILE E.164 정규식 (+82(10|11|16|17|18|19))
- R16: OTP threading.Lock 원자성 + Redis prefix
- R17: JWT 블랙리스트 + Refresh Token Rotation
- R22: IVR kill-switch + F1 알람

## 배포 조건 (블로킹)
- [BLK-C1] 사업자등록번호 + 통신판매업신고번호
- [BLK-C2] 개보법 국외이전 동의 UI (Twilio)
- [BLK-C3] KT클라우드 발신번호 등록

## KPI
- 부모님 응답률: >70%  <!-- [R43+1-MEDIUM-2] 운영 KPI — nova-health 헬스대시보드 동기화 완료 (2026-05-27) -->
- IVR 완료율: >80%
- 유료 전환: 12%
- parent_response_rate_target: ">70%"  <!-- L1 북극성 ↔ L2 운영 KPI 단일화 -->

## Phase 로드맵
- Phase 1: SMS OTP + 양측동의 ✅
- Phase 2: IVR 자동 전화 ✅
- Phase 3: NICE 본인인증 (출시 후)
