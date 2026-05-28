# 노부모케어 앱 기술 아키텍처

> 버전: 1.0.0  
> 최종 수정: 2026-05-22  
> 담당: nova-dev

---

## 1. 개요

노부모케어는 고령 부모(노인)와 보호자(자녀/가족)를 연결하는 모바일 헬스케어 플랫폼이다.
React Native 크로스플랫폼 앱 + Node.js 백엔드 + PostgreSQL 기반으로 구성된다.

### 핵심 목표
- 혈압/혈당/복약 등 건강 데이터 실시간 모니터링 및 이상 알림
- GPS 위치 공유 + 안전구역 이탈 감지
- 보호자-노인 간 실시간 채팅
- 응급 시 SOS 버튼 + 119 연동
- 개인정보보호법 완전 준수

---

## 2. 시스템 전체 구조

```
[모바일 클라이언트]
  iOS / Android (React Native)
       |
       | HTTPS / WSS
       v
[API Gateway / Load Balancer]
  Nginx + SSL termination
       |
  +----+----+
  |         |
  v         v
[REST API]  [WebSocket 서버]
Node.js     Node.js (Socket.IO)
Express     (채팅 / 실시간 알림)
  |              |
  v              v
[PostgreSQL DB]   [Redis]
  메인 데이터     세션/캐시/채팅 큐
       |
       v
[외부 연동]
  - Firebase FCM (푸시 알림)
  - 119 응급 API (소방청)
  - KT/SKT 위치측위 API (선택)
  - AWS S3 (이미지/파일 저장)
```

---

## 3. 기술 스택

### 3.1 프론트엔드 (모바일)

| 항목 | 기술 | 버전 |
|------|------|------|
| 프레임워크 | React Native | 0.74+ |
| 언어 | TypeScript | 5.x |
| 상태관리 | Zustand | 4.x |
| 네비게이션 | React Navigation | 6.x |
| HTTP 클라이언트 | Axios | 1.x |
| 실시간 통신 | Socket.IO Client | 4.x |
| 지도 | React Native Maps | 1.x |
| 알림 | Firebase React Native | - |
| 스토리지 | AsyncStorage / MMKV | - |
| UI 컴포넌트 | React Native Paper | 5.x |
| 빌드 | Expo EAS | - |

### 3.2 백엔드 (API 서버)

| 항목 | 기술 | 버전 |
|------|------|------|
| 런타임 | Node.js | 20 LTS |
| 언어 | TypeScript | 5.x |
| 프레임워크 | Express.js | 4.x |
| ORM | Prisma | 5.x |
| 인증 | JWT (RS256) + Refresh Token | - |
| 실시간 | Socket.IO | 4.x |
| 문서화 | Swagger (swagger-jsdoc) | - |
| 검증 | Zod | 3.x |
| 로깅 | Winston + Morgan | - |
| 테스트 | Jest + Supertest | - |

### 3.3 데이터베이스 / 인프라

| 항목 | 기술 | 용도 |
|------|------|------|
| 메인 DB | PostgreSQL 16 | 사용자/건강/위치 데이터 |
| 캐시/세션 | Redis 7 | 세션, 채팅, 알림 큐 |
| 파일 저장 | AWS S3 | 프로필 사진, 의료 문서 |
| 푸시 알림 | Firebase FCM | iOS/Android 알림 |
| 컨테이너 | Docker + Docker Compose | 개발/배포 환경 |
| CI/CD | GitHub Actions | 자동 빌드/배포 |
| 호스팅 | AWS ECS Fargate | 서버리스 컨테이너 |

---

## 4. 핵심 기능 상세 설계

### 4.1 건강 모니터링

#### 데이터 흐름
```
노인 앱에서 측정값 입력
  → POST /api/health/records
  → DB 저장 + 임계값 검사
  → 이상 감지 시 → Redis Queue 발행
  → 알림 워커 → FCM 푸시 (보호자)
  → WebSocket 이벤트 (실시간 앱 내 알림)
```

#### 임계값 기준 (기본값, 개인화 가능)
| 항목 | 정상 | 경고 | 위험 |
|------|------|------|------|
| 수축기혈압 | 90-139 | 140-159 / <90 | >=160 / <80 |
| 이완기혈압 | 60-89 | 90-99 / <60 | >=100 / <50 |
| 혈당(공복) | 70-99 | 100-125 | >=126 / <70 |
| 심박수 | 60-100 | 50-59 / 101-120 | <50 / >120 |

#### 복약 알림
- 보호자가 복약 일정 등록 (약 이름, 용량, 시간, 반복)
- 알림 스케줄러(node-cron)가 지정 시간에 FCM 발송
- 노인이 앱에서 복약 완료 체크 → 보호자에게 확인 알림

### 4.2 위치 공유 및 안전구역

#### 위치 업데이트 전략
- 노인 앱에서 백그라운드 위치 추적 (5분 간격 기본, 이동 감지 시 1분)
- POST /api/location/update → DB 저장
- 보호자 앱에서 실시간 위치 조회 (WebSocket 구독)

#### 안전구역 로직
```
위치 업데이트 수신
  → 등록된 안전구역 목록과 비교
  → Haversine 공식으로 거리 계산
  → 구역 이탈/진입 감지
  → 보호자에게 즉시 푸시 + 앱 내 알림
```

#### 안전구역 타입
- 집 (가장 우선순위)
- 병원 / 의원
- 단골 가게
- 사용자 정의 장소

### 4.3 실시간 채팅

#### 채팅 아키텍처
```
[클라이언트 A] --Socket.IO--> [Socket 서버]
                                    |
                              Redis Pub/Sub
                                    |
[클라이언트 B] <--Socket.IO-- [Socket 서버]
                                    |
                              PostgreSQL (메시지 영구 저장)
```

#### 채팅방 구조
- 1:1 채팅: 보호자-노인 쌍 (자동 생성)
- 가족방: 여러 보호자 + 노인 1명 (그룹 채팅)
- 메시지 타입: text, image, voice, location, emergency

#### 미디어 메시지
- 이미지/음성: 클라이언트 → S3 presigned URL 업로드 → S3 URL을 메시지 본문에 저장

### 4.4 응급 버튼 + 119 연동

#### SOS 플로우
```
노인이 SOS 버튼 누름 (3초 홀드 또는 연속 5회 탭)
  → POST /api/emergency/sos
  → 즉시 모든 보호자에게 FCM 최우선 알림
  → WebSocket emergency 이벤트 발행
  → 현재 위치 스냅샷 저장
  → 119 API 연동 (소방청 e-안전신고 API)
  → 앱 내 SOS 진행 화면 표시
  → 보호자 1명이 "확인" 누르면 SOS 해제 가능
```

#### 119 API 연동
- 소방청 119 신고 오픈 API (공공데이터포털) 활용
- 위치 좌표 + 노인 정보 + 연락처 자동 전송
- 실패 시 앱에서 직접 전화 연결 fallback

---

## 5. 데이터베이스 스키마

### 5.1 주요 테이블

```sql
-- 사용자 (노인 + 보호자 통합)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         VARCHAR(20) UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE,
  name          VARCHAR(100) NOT NULL,
  role          ENUM('senior', 'caregiver') NOT NULL,
  birth_date    DATE,
  profile_image VARCHAR(500),
  fcm_token     VARCHAR(500),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ  -- soft delete
);

-- 보호자-노인 연결 관계
CREATE TABLE care_relationships (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caregiver_id UUID REFERENCES users(id),
  senior_id    UUID REFERENCES users(id),
  relation     VARCHAR(50),  -- '자녀', '배우자', '형제' 등
  is_primary   BOOLEAN DEFAULT false,
  status       ENUM('pending', 'active', 'inactive'),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(caregiver_id, senior_id)
);

-- 건강 기록
CREATE TABLE health_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id       UUID REFERENCES users(id),
  type            ENUM('blood_pressure', 'blood_sugar', 'heart_rate', 'weight', 'temperature', 'oxygen'),
  value_systolic  NUMERIC(6,2),   -- 혈압 수축기
  value_diastolic NUMERIC(6,2),   -- 혈압 이완기
  value_main      NUMERIC(8,2),   -- 기타 수치
  unit            VARCHAR(20),
  severity        ENUM('normal', 'warning', 'danger') DEFAULT 'normal',
  note            TEXT,
  measured_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 복약 일정
CREATE TABLE medication_schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id     UUID REFERENCES users(id),
  created_by    UUID REFERENCES users(id),
  med_name      VARCHAR(200) NOT NULL,
  dosage        VARCHAR(100),
  scheduled_at  TIME NOT NULL,
  repeat_days   INTEGER[] DEFAULT '{1,2,3,4,5,6,7}', -- 1=월 ~ 7=일
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 복약 기록 (완료/누락)
CREATE TABLE medication_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID REFERENCES medication_schedules(id),
  senior_id   UUID REFERENCES users(id),
  status      ENUM('taken', 'missed', 'skipped'),
  taken_at    TIMESTAMPTZ,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 위치 기록
CREATE TABLE location_records (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id  UUID REFERENCES users(id),
  latitude   NUMERIC(10,7) NOT NULL,
  longitude  NUMERIC(10,7) NOT NULL,
  accuracy   NUMERIC(6,2),
  address    VARCHAR(500),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- 안전구역
CREATE TABLE safe_zones (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id  UUID REFERENCES users(id),
  created_by UUID REFERENCES users(id),
  name       VARCHAR(200) NOT NULL,
  type       ENUM('home', 'hospital', 'store', 'custom'),
  latitude   NUMERIC(10,7) NOT NULL,
  longitude  NUMERIC(10,7) NOT NULL,
  radius_m   INTEGER DEFAULT 200,  -- 반경 미터
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 채팅방
CREATE TABLE chat_rooms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       ENUM('direct', 'family'),
  name       VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 채팅 참가자
CREATE TABLE chat_participants (
  room_id    UUID REFERENCES chat_rooms(id),
  user_id    UUID REFERENCES users(id),
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

-- 채팅 메시지
CREATE TABLE chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID REFERENCES chat_rooms(id),
  sender_id  UUID REFERENCES users(id),
  type       ENUM('text', 'image', 'voice', 'location', 'emergency'),
  content    TEXT,
  media_url  VARCHAR(500),
  sent_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- 응급 이벤트
CREATE TABLE emergency_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id   UUID REFERENCES users(id),
  latitude    NUMERIC(10,7),
  longitude   NUMERIC(10,7),
  status      ENUM('active', 'acknowledged', 'resolved'),
  sos_sent_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  note        TEXT
);

-- 알림 로그
CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id),
  type       VARCHAR(100),
  title      VARCHAR(300),
  body       TEXT,
  data       JSONB,
  is_read    BOOLEAN DEFAULT false,
  sent_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### 5.2 인덱스 전략

```sql
-- 건강 기록 조회 최적화
CREATE INDEX idx_health_records_senior_type ON health_records(senior_id, type, measured_at DESC);

-- 위치 최신 기록
CREATE INDEX idx_location_senior_time ON location_records(senior_id, recorded_at DESC);

-- 채팅 메시지 조회
CREATE INDEX idx_chat_messages_room ON chat_messages(room_id, sent_at DESC);

-- 알림 미읽음
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, is_read, sent_at DESC);

-- PostGIS (위치 쿼리 최적화, 선택적)
-- CREATE EXTENSION postgis;
-- ALTER TABLE safe_zones ADD COLUMN geog geography(POINT);
```

---

## 6. 인증 및 보안

### 6.1 인증 흐름

```
[회원가입]
휴대폰 번호 입력
→ SMS OTP 발송 (6자리, 3분 유효)
→ OTP 검증 → Access Token (15분) + Refresh Token (30일) 발급
→ Refresh Token → DB 저장 + 클라이언트 SecureStorage 저장

[로그인]
휴대폰 번호 + OTP
→ 동일 플로우

[토큰 갱신]
POST /api/auth/refresh
→ Refresh Token 검증
→ 새 Access Token 발급
```

### 6.2 보안 원칙
- HTTPS 필수 (TLS 1.3)
- JWT RS256 서명 (비대칭키)
- Refresh Token은 DB에 해시 저장 (bcrypt)
- API Rate Limiting: express-rate-limit (100 req/min 기본)
- SQL Injection: Prisma ORM 파라미터 바인딩
- XSS: 입력 sanitization (validator.js)
- CORS: 허용 도메인 화이트리스트
- 헬스 데이터 암호화: 민감 컬럼 AES-256 암호화 (DB 레벨)

---

## 7. 개인정보보호법 컴플라이언스

### 7.1 체크리스트

| 항목 | 구현 방법 | 상태 |
|------|-----------|------|
| 개인정보 수집 동의 | 회원가입 시 동의 화면 + DB 동의 기록 저장 | 설계 완료 |
| 수집 최소화 원칙 | 필수/선택 항목 분리, 불필요 수집 금지 | 설계 완료 |
| 목적 외 이용 금지 | API 레벨에서 용도별 접근 제한 | 설계 완료 |
| 보유기간 설정 | 회원 탈퇴 후 30일 내 파기 (soft delete → hard delete 배치) | 설계 완료 |
| 정보주체 권리 보장 | 조회/수정/삭제/이동 API 제공 | 설계 완료 |
| 위탁 관리 | AWS, Firebase 등 위탁업체 계약서 체결 | 운영 시 필요 |
| 보안 조치 | 암호화, 접근통제, 접속 로그 | 설계 완료 |
| 노인 등 취약계층 | 법정대리인(보호자) 동의 절차 포함 | 설계 완료 |
| 파기 절차 | 탈퇴 배치 잡 + 파기 확인 로그 | 설계 완료 |
| 개인정보처리방침 | 앱 내 상시 열람 가능 페이지 | 설계 완료 |

### 7.2 민감 데이터 처리

- 건강 데이터(혈압/혈당 등): 별도 동의 획득 (민감정보)
- 위치 정보: 별도 동의 획득 + 보유 기간 90일
- 의료 문서: AES-256 암호화 저장, S3 Private 버킷
- 로그 데이터: IP 마스킹 처리

---

## 8. 시스템 비기능 요건

| 항목 | 목표 |
|------|------|
| API 응답시간 | P95 < 300ms |
| 가용성 | 99.9% (월 다운타임 < 44분) |
| 동시 사용자 | 10,000명 (초기 목표) |
| 위치 업데이트 처리 | 1,000 req/sec |
| 채팅 메시지 전달 | 실시간 (< 1초 지연) |
| 데이터 백업 | 매일 자동 백업, 30일 보관 |
| 장애 복구 | RTO < 1시간, RPO < 1일 |

---

## 9. 배포 구조

```
GitHub Actions CI/CD
  → 테스트 (Jest)
  → Docker 이미지 빌드
  → ECR 푸시
  → ECS 롤링 배포

[프로덕션]
AWS ECS Fargate
  - API 서버 (2+ 태스크, Auto Scaling)
  - WebSocket 서버 (2+ 태스크, Sticky Session)

AWS RDS PostgreSQL (Multi-AZ)
AWS ElastiCache Redis (Cluster)
AWS S3 + CloudFront (미디어)
AWS ALB (로드밸런서)
```

---

## 10. 모니터링 및 운영

- 애플리케이션 모니터링: AWS CloudWatch + Datadog
- 에러 트래킹: Sentry
- 로그 집계: CloudWatch Logs
- 알림: PagerDuty (장애 시 온콜)
- 성능 모니터링: AWS X-Ray (분산 추적)
