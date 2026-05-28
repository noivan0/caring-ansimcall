# 케어링(안심콜) 기술스택 — MVP v1.0

## 서비스 포지션
**알림 서비스** (의료기기/의료서비스 아님) — 정보통신서비스

## Backend
- **FastAPI** (Python 3.11) — REST API 서버
- **PostgreSQL** + SQLAlchemy — 메인 DB
- **Redis** — 알림 스케줄 큐, 세션
- **Celery** — 비동기 태스크 (전화 발신, 푸시)

## AI 전화 (IVR)
- **Twilio Voice API** — 전화 발신 + TTS
  - 대안: Google Cloud TTS + Twilio (한국어 품질 우수)
- 전화 플로우: Twilio → TwiML → 음성 응답 인식
- 미응답 재시도: 3회 → 자녀 FCM 푸시

## 푸시 알림
- **Firebase FCM** — iOS/Android 모두 지원

## Frontend (자녀 앱)
- **React Native (Expo)** — iOS+Android 동시
- **React Query** + Zustand 상태관리

## 인프라
- **Docker Compose** — 로컬/서버 동일 환경
- **Nginx** — 리버스 프록시

## 보안/법적
- 개인정보 로컬 암호화 (AES-256)
- 복약 일정 데이터 제3자 미제공
- AI 전화 음성: 의료 행위 아님 고지 포함

## 선택 이유
- Twilio: 한국 번호 발신 지원 + TTS 품질 우수
- Expo: 빠른 MVP, OTA 업데이트 가능
- FastAPI: 비동기 처리, 자동 API 문서
