# 노부모케어 API — 운영팀 인수인계서

작성일: 2026-05-22
상태: 테스트 73/73 통과, 배포 준비 완료

---

## 1. 시스템 개요

노인 원격 케어 플랫폼 API 서버

- 핵심 기능: 건강 모니터링, 위치 공유, 복약 알림, 응급 SOS
- 스택: Node.js 20 + Express 4, PostgreSQL 16, Redis 7, Socket.IO
- 아키텍처: REST API + WebSocket (실시간 알림/채팅)

---

## 2. 실행 방법

### 로컬 개발 (npm)

```bash
# 1) 의존성 설치
npm install

# 2) 환경변수 설정 (.env.example 참조)
cp .env.example .env
# .env 파일 직접 수정 (3번 환경변수 목록 참조)

# 3) 서버 기동
npm start          # 프로덕션 모드 (node src/app.js)
npm run dev        # 개발 모드 (nodemon 핫리로드)

# 4) 테스트
npm test           # 전체 테스트 + 커버리지 (73/73 통과)
```

서버 포트: 3001 (PORT 환경변수로 변경 가능)

### Docker Compose (권장)

```bash
# 1) 환경변수 파일 준비
cp .env.example .env
# DB_PASSWORD, SECRET_KEY, REFRESH_SECRET_KEY 반드시 설정

# 2) 전체 스택 기동 (API + PostgreSQL 16 + Redis 7)
docker compose up -d

# 3) 기동 확인
curl http://localhost:3001/ping          # {"status":"ok","ts":...}
curl http://localhost:3001/api/v1/health # DB/Redis 상태 확인

# 4) 로그 확인
docker compose logs -f api
docker compose logs -f postgres

# 5) DB 스키마 초기화 (최초 기동 시 자동 실행)
# docker-entrypoint-initdb.d/01_schema.sql 자동 적용
# 이후 마이그레이션
docker compose run --rm migrate
```

포트 매핑:
- API: 3001 (외부 3001)
- PostgreSQL: 5433 (외부 5433 → 내부 5432, 충돌 방지)
- Redis: 내부만 (외부 노출 없음)

---

## 3. 환경변수 목록 (.env.example 참조)

| 변수명 | 필수 | 설명 |
|--------|------|------|
| SECRET_KEY | 필수 | JWT 액세스 토큰 시크릿 (최소 32자, openssl rand -hex 32) |
| REFRESH_SECRET_KEY | 필수 | JWT 리프레시 토큰 시크릿 (SECRET_KEY와 반드시 다른 값) |
| DB_HOST | 필수 | PostgreSQL 호스트 (Docker: postgres) |
| DB_PORT | 필수 | PostgreSQL 포트 (기본 5432) |
| DB_NAME | 필수 | 데이터베이스 이름 (기본 senior_care_db) |
| DB_USER | 필수 | DB 사용자 (기본 caring) |
| DB_PASSWORD | 필수 | DB 비밀번호 (강력한 값 사용) |
| DATABASE_URL | 선택 | postgresql://user:pass@host:5432/db (Docker Compose 자동 생성) |
| REDIS_URL | 필수 | Redis 연결 URL (기본 redis://localhost:6379/0) |
| TWILIO_ACCOUNT_SID | 선택 | Twilio SID (SMS/IVR 응급알림 사용 시) |
| TWILIO_AUTH_TOKEN | 선택 | Twilio 인증 토큰 |
| TWILIO_FROM_NUMBER | 선택 | 발신 전화번호 (+82xxxxxxxxxx 형식) |
| NODE_ENV | 선택 | 실행 환경 (development/production/test) |
| PORT | 선택 | 서버 포트 (기본 3001) |
| DB_POOL_MAX | 선택 | DB 연결 풀 최대 수 (기본 10) |
| ALLOWED_ORIGINS | 선택 | CORS 허용 출처 (쉼표 구분, 기본 http://localhost:3000) |

---

## 4. 개인정보보호법 컴플라이언스 체크리스트

### 개인정보보호법 제15조 — 수집 최소화 원칙

- [x] 위치 정보: 노인 본인 또는 보호자 동의 관계에서만 수집
- [x] 의료 정보(복약): 관계 인증된 보호자만 접근
- [x] 회원 가입 시 필수 항목만 수집 (이름, 이메일, 역할)

### 개인정보보호법 제22조 — 동의 수집

- [x] 보호자-노인 관계 생성 시 pending 상태로 시작
- [x] 노인 본인이 수락(accepted)/거부(rejected) 선택
- [x] 동의 없는 관계로는 위치/건강 데이터 접근 불가
- [x] API: `PATCH /api/v1/users/relationships/:id` (status: accepted/rejected)

### 개인정보보호법 제36조 — 정정·삭제권 (잊혀질 권리)

- [x] 회원 탈퇴 시 개인정보 즉시 익명화 (User.anonymize 호출)
- [x] 탈퇴 전 리프레시 토큰 전부 무효화 (DB UPDATE)
- [x] API: `DELETE /api/v1/auth/account` (204 No Content)

### 로그·응답 마스킹

- [x] password_hash 응답 미포함 (User.findById에서 제외)
- [x] JWT 토큰 만료 시 즉시 폐기 (15분 액세스 / 30일 리프레시)
- [x] DB 슬로우 쿼리 로그: 100ms 초과 시만 기록 (비프로덕션)

### 접근 제어

- [x] 모든 API 엔드포인트 JWT 인증 필수 (authenticate 미들웨어)
- [x] 역할 기반 접근 제어: elder/guardian/admin
- [x] 관계 기반 접근 제어: checkRelationship 미들웨어 (위치/응급)

---

## 5. 응급 알림 흐름도

```
노인 SOS 트리거
       │
       ▼
POST /api/v1/emergency/elder/:elderId/sos
       │
       ├──► DB SOS 이벤트 기록 (emergency_events 테이블)
       │
       ├──► 보호자 전원 즉시 푸시 알림 (FCM / notifyGuardians)
       │         └── Firebase Admin SDK → 보호자 앱
       │
       └──► 119 API 연동 (비동기, 실패 시 fallback)
                 └── Twilio IVR / REST API
                 └── 실패 시에도 보호자 알림은 보장

SOS 해제:
POST /api/v1/emergency/elder/:elderId/resolve
       └──► DB 상태 resolved 업데이트
```

복약 알림 흐름:
```
node-cron 스케줄 (매분 실행)
       │
       ▼
복약 일정 확인 (medication_schedules 테이블)
       │
       ├── 미확인 시 → 보호자 1차 알림 (일반 FCM)
       │
       └── 3회 연속 미확인 → 에스컬레이션 (highPriority FCM)
                └── console.warn 로그 기록
```

---

## 6. 모니터링 지표

### 주요 API 응답코드 추적

| 엔드포인트 | 정상 | 의미 |
|-----------|------|------|
| POST /api/v1/auth/login | 200 | 로그인 성공 |
| POST /api/v1/auth/login | 401 | 잘못된 자격증명 |
| POST /api/v1/location/elder/:id | 201 | 위치 기록 성공 |
| POST /api/v1/emergency/elder/:id/sos | 201 | SOS 접수 |
| DELETE /api/v1/auth/account | 204 | 탈퇴 완료 |

### 헬스체크 엔드포인트

```bash
# 빠른 생존 확인 (로드밸런서)
GET /ping
# {"status":"ok","ts":1716355200000}

# Liveness probe (Kubernetes) — 프로세스 생존만 확인, 항상 200
GET /health/live
# {"status":"alive","ts":1716355200000}

# Readiness probe (Kubernetes) — DB+Redis 정상 시 200, 오류 시 503
GET /health/ready
# 정상: {"status":"ready","db":"ok","redis":"ok","version":"1.0.0"}
# 오류: {"status":"not_ready","db":"error","redis":"ok","version":"1.0.0"}  → 503

# 상세 헬스 (DB + Redis + 버전, 항상 200)
GET /api/v1/health
# {"status":"ok","db":"ok","redis":"ok","version":"1.0.0"}
# status: "degraded" 시 DB/Redis 필드 확인 필요
```

Kubernetes Deployment 예시:
```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /health/ready
    port: 3001
  initialDelaySeconds: 15
  periodSeconds: 10
  failureThreshold: 3
```

### 알람 기준 (권장)

- `POST /api/v1/emergency/.*/sos` 5분 내 응답 없음 → PagerDuty
- DB 연결 오류 3회 연속 → Slack #senior-care-ops
- Redis 연결 실패 → 리프레시 토큰 발급 불가 → 즉시 대응
- CPU 80% 이상 10분 지속 → Node.js 인스턴스 스케일아웃
- 복약 미확인 에스컬레이션 로그(`[복약 에스컬레이션]`) 급증 → 알림 서비스 점검

### 로그 경로

```bash
# Docker Compose
docker compose logs -f api          # 실시간 API 로그
docker compose logs api | grep ERROR  # 에러 필터

# 직접 실행 시
NODE_ENV=production npm start 2>&1 | tee /var/log/senior-care/api.log
```

---

## 7. API 엔드포인트 요약

```
인증
  POST   /api/v1/auth/register     회원가입
  POST   /api/v1/auth/login        로그인 (JWT 발급)
  POST   /api/v1/auth/refresh      액세스 토큰 갱신
  POST   /api/v1/auth/logout       로그아웃 (토큰 무효화)
  DELETE /api/v1/auth/account      회원 탈퇴 (익명화)

사용자
  GET    /api/v1/users/me                   내 프로필
  PATCH  /api/v1/users/me                   프로필 수정
  GET    /api/v1/users/me/elders            케어 중인 노인 목록
  POST   /api/v1/users/relationships        보호자-노인 연결 요청
  PATCH  /api/v1/users/relationships/:id   동의 수락/거부
  DELETE /api/v1/users/relationships/:id   관계 해제

위치
  POST   /api/v1/location/elder/:elderId           위치 기록
  GET    /api/v1/location/elder/:elderId/current   현재 위치
  GET    /api/v1/location/elder/:elderId/history   위치 이력
  POST   /api/v1/location/elder/:elderId/safe-zones   안전구역 등록
  GET    /api/v1/location/elder/:elderId/safe-zones   안전구역 조회
  DELETE /api/v1/location/elder/:elderId/safe-zones/:zoneId 삭제

복약
  (medications 라우터 참조)

응급
  POST   /api/v1/emergency/elder/:elderId/sos     SOS 트리거
  GET    /api/v1/emergency/elder/:elderId/history  이력
  POST   /api/v1/emergency/elder/:elderId/resolve  SOS 해제

헬스
  GET    /ping                헬스체크 (로드밸런서)
  GET    /api/v1/health       상세 (DB + Redis)
```

---

## 8. 테스트 현황

실행: `npm test` (또는 `node_modules/.bin/jest --forceExit`)

```
Test Suites: 5 passed, 5 total
Tests:       73 passed, 73 total
Coverage:    src/**/*.js
```

테스트 파일:
- `__tests__/auth.test.js`      — JWT 인증 흐름 (등록/로그인/갱신/로그아웃)
- `__tests__/location.test.js`  — 위치 공유 API (기록/조회/안전구역)
- `__tests__/medication.test.js` — 복약 알림 스케줄러
- `__tests__/privacy.test.js`   — 개인정보보호법 컴플라이언스 (동의/삭제/마스킹)
- `__tests__/security.test.js`  — 보안 테스트 (인증/인가)

---

*인계 완료. 문의: senior-care 개발팀 Slack #senior-care-dev*
