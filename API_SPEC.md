# 노부모케어 API 설계서

> 버전: 1.0.0  
> 형식: OpenAPI 3.0 (Swagger)  
> Base URL: `https://api.nobumocare.com/api/v1`  
> 최종 수정: 2026-05-22

---

## 인증 방식

모든 API (인증 제외)는 Authorization 헤더 필수:

```
Authorization: Bearer {access_token}
```

Access Token 만료(15분) 시 `/auth/refresh`로 갱신.

---

## 공통 응답 형식

### 성공 응답
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100
  }
}
```

### 에러 응답
```json
{
  "success": false,
  "error": {
    "code": "HEALTH_RECORD_NOT_FOUND",
    "message": "건강 기록을 찾을 수 없습니다.",
    "details": []
  }
}
```

### HTTP 상태 코드
| 코드 | 의미 |
|------|------|
| 200 | OK - 성공 |
| 201 | Created - 리소스 생성 성공 |
| 204 | No Content - 삭제 성공 |
| 400 | Bad Request - 요청 형식 오류 |
| 401 | Unauthorized - 인증 실패 |
| 403 | Forbidden - 권한 없음 |
| 404 | Not Found - 리소스 없음 |
| 409 | Conflict - 중복 요청 |
| 422 | Unprocessable Entity - 검증 실패 |
| 429 | Too Many Requests - 요청 한도 초과 |
| 500 | Internal Server Error |

---

## API 목록

### 0. 헬스 프로브 (Health Probes)

K8s liveness/readiness probe용 엔드포인트. 인증 불필요.

---

#### GET /health/live
Liveness probe — 프로세스 생존 확인 (DB 무관)

| 항목 | 값 |
|---|---|
| 인증 | 불필요 |
| 응답 | 항상 200 |

**Response 200**
```json
{
  "status": "alive",
  "service": "caring-api"
}
```

---

#### GET /health/ready
Readiness probe — DB 연결 성공 시 트래픽 수신

| 항목 | 값 |
|---|---|
| 인증 | 불필요 |
| DB 연결 OK | 200 |
| DB 연결 실패 | 503 |

**Response 200 (정상)**
```json
{
  "status": "ready",
  "service": "caring-api",
  "db": "ok"
}
```

**Response 503 (DB 실패)**
```json
{
  "status": "not_ready",
  "service": "caring-api",
  "db": "error"
}
```

**보안**: 에러 상세 미노출 (`db=error`만 반환), connect_timeout=3s I/O 가드 적용

---

### 1. 인증 (Auth)

---

#### POST /auth/send-otp
SMS OTP 발송 (회원가입/로그인 공용)

**Request Body**
```json
{
  "phone": "01012345678"
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "expires_in": 180,
    "message": "OTP가 발송되었습니다."
  }
}
```

**에러 코드**
- `INVALID_PHONE` - 잘못된 전화번호 형식
- `OTP_RATE_LIMIT` - 1분 내 재발송 불가

---

#### POST /auth/verify-otp
OTP 검증 + 토큰 발급

**Request Body**
```json
{
  "phone": "01012345678",
  "otp": "123456",
  "device_id": "device-uuid-here",
  "fcm_token": "firebase-token-here"
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGci...",
    "refresh_token": "eyJhbGci...",
    "token_type": "Bearer",
    "expires_in": 900,
    "user": {
      "id": "uuid",
      "name": "홍길동",
      "role": "senior",
      "is_new_user": false
    }
  }
}
```

**에러 코드**
- `OTP_INVALID` - OTP 불일치
- `OTP_EXPIRED` - OTP 만료 (3분)
- `OTP_MAX_ATTEMPTS` - 5회 초과 시도

---

#### POST /auth/refresh
Access Token 갱신

**Request Body**
```json
{
  "refresh_token": "eyJhbGci..."
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "access_token": "eyJhbGci...",
    "expires_in": 900
  }
}
```

---

#### POST /auth/logout
로그아웃 (Refresh Token 무효화)

**Headers**: Authorization 필수

**Response 204** (No Content)

---

### 2. 사용자 (Users)

---

#### GET /users/me
내 프로필 조회

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "phone": "01012345678",
    "email": "user@example.com",
    "name": "홍길동",
    "role": "senior",
    "birth_date": "1950-03-15",
    "profile_image": "https://cdn.nobumocare.com/profiles/uuid.jpg",
    "created_at": "2026-01-01T00:00:00Z"
  }
}
```

---

#### PATCH /users/me
내 프로필 수정

**Request Body** (모든 필드 선택)
```json
{
  "name": "홍길동",
  "email": "user@example.com",
  "birth_date": "1950-03-15",
  "profile_image": "base64_or_s3_url"
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "홍길동",
    "updated_at": "2026-05-22T00:00:00Z"
  }
}
```

---

#### DELETE /users/me
회원 탈퇴 (soft delete, 30일 후 완전 삭제)

**Request Body**
```json
{
  "reason": "서비스 이용 종료",
  "password_confirm": "OTP 재인증 필요"
}
```

**Response 204**

---

#### GET /users/me/consent
개인정보 동의 내역 조회

**Response 200**
```json
{
  "success": true,
  "data": {
    "terms_agreed": true,
    "terms_agreed_at": "2026-01-01T00:00:00Z",
    "privacy_agreed": true,
    "privacy_agreed_at": "2026-01-01T00:00:00Z",
    "health_data_agreed": true,
    "health_data_agreed_at": "2026-01-01T00:00:00Z",
    "location_agreed": true,
    "location_agreed_at": "2026-01-01T00:00:00Z",
    "marketing_agreed": false
  }
}
```

---

#### POST /users/me/consent
동의 항목 갱신

**Request Body**
```json
{
  "marketing_agreed": true
}
```

**Response 200**

---

### 3. 보호자-노인 관계 (Relationships)

---

#### POST /relationships/invite
연결 초대 코드 생성 (보호자가 노인에게 발송)

**Response 201**
```json
{
  "success": true,
  "data": {
    "invite_code": "ABC123",
    "invite_url": "https://nobumocare.com/invite/ABC123",
    "expires_at": "2026-05-23T00:00:00Z"
  }
}
```

---

#### POST /relationships/accept
초대 수락 (노인이 보호자 초대 수락)

**Request Body**
```json
{
  "invite_code": "ABC123",
  "relation": "자녀"
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "relationship_id": "uuid",
    "caregiver": {
      "id": "uuid",
      "name": "홍자녀",
      "profile_image": "..."
    },
    "relation": "자녀",
    "status": "active"
  }
}
```

---

#### GET /relationships
내 연결 관계 목록 조회

**Query Parameters**
- `role` (optional): `caregiver` | `senior`

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "role": "caregiver",
      "partner": {
        "id": "uuid",
        "name": "홍부모",
        "birth_date": "1950-03-15",
        "profile_image": "..."
      },
      "relation": "자녀",
      "is_primary": true,
      "status": "active",
      "created_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

---

#### DELETE /relationships/{relationship_id}
연결 해제

**Response 204**

---

### 4. 건강 모니터링 (Health)

---

#### POST /health/records
건강 데이터 기록

**Request Body**
```json
{
  "type": "blood_pressure",
  "value_systolic": 135,
  "value_diastolic": 85,
  "value_main": null,
  "unit": "mmHg",
  "measured_at": "2026-05-22T08:30:00Z",
  "note": "아침 식사 전 측정"
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "type": "blood_pressure",
    "value_systolic": 135,
    "value_diastolic": 85,
    "unit": "mmHg",
    "severity": "normal",
    "measured_at": "2026-05-22T08:30:00Z",
    "alert_sent": false
  }
}
```

건강 데이터 타입:
- `blood_pressure`: value_systolic + value_diastolic (mmHg)
- `blood_sugar`: value_main (mg/dL)
- `heart_rate`: value_main (bpm)
- `weight`: value_main (kg)
- `temperature`: value_main (°C)
- `oxygen`: value_main (%)

---

#### GET /health/records
건강 기록 목록 조회

**Query Parameters**
- `senior_id` (required for caregiver): 노인 UUID
- `type` (optional): 데이터 타입 필터
- `from` (optional): 시작 날짜 (ISO8601)
- `to` (optional): 종료 날짜 (ISO8601)
- `page` (optional, default 1)
- `limit` (optional, default 20, max 100)

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "type": "blood_pressure",
      "value_systolic": 135,
      "value_diastolic": 85,
      "unit": "mmHg",
      "severity": "normal",
      "measured_at": "2026-05-22T08:30:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 45
  }
}
```

---

#### GET /health/records/summary
건강 데이터 요약 (최신값 + 7일 트렌드)

**Query Parameters**
- `senior_id` (required for caregiver)

**Response 200**
```json
{
  "success": true,
  "data": {
    "blood_pressure": {
      "latest": {
        "value_systolic": 135,
        "value_diastolic": 85,
        "severity": "normal",
        "measured_at": "2026-05-22T08:30:00Z"
      },
      "trend": "stable",
      "weekly_avg_systolic": 132.5,
      "weekly_avg_diastolic": 83.2
    },
    "blood_sugar": {
      "latest": null,
      "trend": null
    }
  }
}
```

---

#### GET /health/thresholds
개인화 임계값 조회

**Query Parameters**
- `senior_id` (required for caregiver)

**Response 200**
```json
{
  "success": true,
  "data": {
    "blood_pressure": {
      "systolic_warning_high": 140,
      "systolic_danger_high": 160,
      "systolic_warning_low": 90,
      "systolic_danger_low": 80
    },
    "blood_sugar": {
      "fasting_warning_high": 100,
      "fasting_danger_high": 126
    }
  }
}
```

---

#### PUT /health/thresholds
임계값 수정 (보호자 또는 노인 본인)

**Request Body**
```json
{
  "senior_id": "uuid",
  "blood_pressure": {
    "systolic_warning_high": 145
  }
}
```

**Response 200**

---

### 5. 복약 관리 (Medications)

---

#### POST /medications/schedules
복약 일정 등록

**Request Body**
```json
{
  "senior_id": "uuid",
  "med_name": "아스피린",
  "dosage": "100mg 1정",
  "scheduled_at": "08:00",
  "repeat_days": [1, 2, 3, 4, 5, 6, 7],
  "note": "식후 복용"
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "med_name": "아스피린",
    "dosage": "100mg 1정",
    "scheduled_at": "08:00",
    "repeat_days": [1, 2, 3, 4, 5, 6, 7],
    "is_active": true
  }
}
```

---

#### GET /medications/schedules
복약 일정 목록

**Query Parameters**
- `senior_id` (required for caregiver)
- `is_active` (optional, default true)

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "med_name": "아스피린",
      "dosage": "100mg 1정",
      "scheduled_at": "08:00",
      "repeat_days": [1, 2, 3, 4, 5, 6, 7],
      "is_active": true,
      "today_status": "taken"
    }
  ]
}
```

---

#### PATCH /medications/schedules/{schedule_id}
복약 일정 수정

---

#### DELETE /medications/schedules/{schedule_id}
복약 일정 삭제 (비활성화)

---

#### POST /medications/logs
복약 완료/누락 기록

**Request Body**
```json
{
  "schedule_id": "uuid",
  "status": "taken",
  "taken_at": "2026-05-22T08:15:00Z",
  "note": ""
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "taken",
    "taken_at": "2026-05-22T08:15:00Z"
  }
}
```

---

#### GET /medications/logs
복약 기록 조회

**Query Parameters**
- `senior_id`
- `from`, `to` (날짜 범위)
- `schedule_id` (optional)

---

### 6. 위치 (Location)

---

#### POST /location/update
위치 업데이트 (노인 앱에서 주기적으로 호출)

**Request Body**
```json
{
  "latitude": 37.5665,
  "longitude": 126.9780,
  "accuracy": 10.5,
  "address": "서울특별시 중구 세종대로 110"
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "recorded_at": "2026-05-22T10:30:00Z",
    "safe_zone_status": {
      "in_safe_zone": true,
      "zone_name": "집",
      "zone_type": "home"
    }
  }
}
```

---

#### GET /location/current/{senior_id}
노인 현재 위치 조회 (보호자용)

**Response 200**
```json
{
  "success": true,
  "data": {
    "latitude": 37.5665,
    "longitude": 126.9780,
    "accuracy": 10.5,
    "address": "서울특별시 중구 세종대로 110",
    "recorded_at": "2026-05-22T10:30:00Z",
    "safe_zone_status": {
      "in_safe_zone": true,
      "zone_name": "집"
    }
  }
}
```

---

#### GET /location/history/{senior_id}
위치 이동 기록 조회

**Query Parameters**
- `from`, `to` (날짜 범위)
- `limit` (default 100, max 500)

---

#### POST /location/safe-zones
안전구역 등록

**Request Body**
```json
{
  "senior_id": "uuid",
  "name": "집",
  "type": "home",
  "latitude": 37.5665,
  "longitude": 126.9780,
  "radius_m": 200
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "집",
    "type": "home",
    "latitude": 37.5665,
    "longitude": 126.9780,
    "radius_m": 200,
    "is_active": true
  }
}
```

---

#### GET /location/safe-zones
안전구역 목록 조회

**Query Parameters**
- `senior_id`

---

#### PATCH /location/safe-zones/{zone_id}
안전구역 수정

---

#### DELETE /location/safe-zones/{zone_id}
안전구역 삭제

---

### 7. 채팅 (Chat)

---

#### GET /chat/rooms
채팅방 목록 조회

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "type": "direct",
      "name": null,
      "participants": [
        {
          "id": "uuid",
          "name": "홍부모",
          "profile_image": "..."
        }
      ],
      "last_message": {
        "type": "text",
        "content": "잘 계세요?",
        "sent_at": "2026-05-22T10:00:00Z"
      },
      "unread_count": 2
    }
  ]
}
```

---

#### POST /chat/rooms
채팅방 생성 (가족방)

**Request Body**
```json
{
  "type": "family",
  "name": "홍씨 가족방",
  "participant_ids": ["uuid1", "uuid2", "uuid3"]
}
```

---

#### GET /chat/rooms/{room_id}/messages
메시지 목록 조회 (페이지네이션, 최신순)

**Query Parameters**
- `before` (optional): 특정 메시지 ID 이전 메시지 조회 (커서 기반)
- `limit` (default 50, max 100)

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "sender": {
        "id": "uuid",
        "name": "홍자녀",
        "profile_image": "..."
      },
      "type": "text",
      "content": "안녕하세요 어머니",
      "media_url": null,
      "sent_at": "2026-05-22T10:00:00Z"
    },
    {
      "id": "uuid2",
      "sender": {
        "id": "uuid",
        "name": "홍부모"
      },
      "type": "image",
      "content": null,
      "media_url": "https://cdn.nobumocare.com/chat/image.jpg",
      "sent_at": "2026-05-22T10:05:00Z"
    }
  ],
  "meta": {
    "has_more": true,
    "oldest_id": "uuid"
  }
}
```

---

#### POST /chat/rooms/{room_id}/messages
메시지 전송 (텍스트)

**Request Body**
```json
{
  "type": "text",
  "content": "잘 계세요?"
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "type": "text",
    "content": "잘 계세요?",
    "sent_at": "2026-05-22T10:30:00Z"
  }
}
```

---

#### POST /chat/rooms/{room_id}/messages/upload-url
미디어 업로드 URL 발급 (S3 presigned URL)

**Request Body**
```json
{
  "file_name": "photo.jpg",
  "content_type": "image/jpeg",
  "file_size": 204800
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "upload_url": "https://s3.amazonaws.com/...presigned...",
    "media_url": "https://cdn.nobumocare.com/chat/uuid/photo.jpg",
    "expires_in": 300
  }
}
```

클라이언트는 upload_url로 PUT 업로드 후, media_url을 메시지 전송 시 포함.

---

#### POST /chat/rooms/{room_id}/messages/read
메시지 읽음 처리

**Request Body**
```json
{
  "message_id": "uuid"
}
```

**Response 200**

---

### 8. 응급 (Emergency)

---

#### POST /emergency/sos
SOS 신호 발송

**Request Body**
```json
{
  "latitude": 37.5665,
  "longitude": 126.9780,
  "message": ""
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "event_id": "uuid",
    "status": "active",
    "notified_caregivers": [
      {
        "id": "uuid",
        "name": "홍자녀",
        "notification_sent": true
      }
    ],
    "emergency_service_sent": true,
    "sos_sent_at": "2026-05-22T11:00:00Z"
  }
}
```

---

#### GET /emergency/events
응급 이벤트 이력 조회

**Query Parameters**
- `senior_id`
- `status` (optional): `active` | `acknowledged` | `resolved`
- `page`, `limit`

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "senior": {
        "id": "uuid",
        "name": "홍부모"
      },
      "latitude": 37.5665,
      "longitude": 126.9780,
      "address": "서울특별시 중구 세종대로 110",
      "status": "resolved",
      "sos_sent_at": "2026-05-22T11:00:00Z",
      "resolved_at": "2026-05-22T11:15:00Z",
      "resolved_by": {
        "id": "uuid",
        "name": "홍자녀"
      }
    }
  ]
}
```

---

#### POST /emergency/events/{event_id}/acknowledge
응급 이벤트 확인 (보호자)

**Response 200**
```json
{
  "success": true,
  "data": {
    "event_id": "uuid",
    "status": "acknowledged",
    "acknowledged_by": "홍자녀",
    "acknowledged_at": "2026-05-22T11:05:00Z"
  }
}
```

---

#### POST /emergency/events/{event_id}/resolve
응급 이벤트 해제

**Request Body**
```json
{
  "note": "직접 확인 완료, 이상 없음"
}
```

**Response 200**

---

### 9. 알림 (Notifications)

---

#### GET /notifications
알림 목록 조회

**Query Parameters**
- `is_read` (optional): `true` | `false`
- `type` (optional): 알림 타입 필터
- `page`, `limit`

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "type": "health_alert",
      "title": "혈압 주의",
      "body": "홍부모님의 수축기 혈압이 155mmHg입니다.",
      "data": {
        "health_record_id": "uuid",
        "senior_id": "uuid"
      },
      "is_read": false,
      "sent_at": "2026-05-22T08:35:00Z"
    }
  ],
  "meta": {
    "unread_count": 5
  }
}
```

---

#### POST /notifications/{notification_id}/read
알림 읽음 처리

**Response 200**

---

#### POST /notifications/read-all
전체 알림 읽음 처리

**Response 200**

---

#### GET /notifications/settings
알림 설정 조회

**Response 200**
```json
{
  "success": true,
  "data": {
    "health_alert": true,
    "medication_reminder": true,
    "location_alert": true,
    "chat_message": true,
    "emergency": true,
    "quiet_hours_enabled": false,
    "quiet_hours_start": "22:00",
    "quiet_hours_end": "07:00"
  }
}
```

---

#### PATCH /notifications/settings
알림 설정 수정

**Request Body**
```json
{
  "quiet_hours_enabled": true,
  "quiet_hours_start": "23:00",
  "quiet_hours_end": "07:00"
}
```

---

## WebSocket 이벤트 (Socket.IO)

연결 시 Authorization 헤더 또는 쿼리 파라미터로 토큰 전달:
```
wss://api.nobumocare.com?token={access_token}
```

### 클라이언트 → 서버 이벤트

| 이벤트 | 데이터 | 설명 |
|--------|--------|------|
| `join_room` | `{ room_id }` | 채팅방 입장 |
| `leave_room` | `{ room_id }` | 채팅방 퇴장 |
| `send_message` | `{ room_id, type, content, media_url }` | 메시지 전송 |
| `typing_start` | `{ room_id }` | 타이핑 시작 |
| `typing_stop` | `{ room_id }` | 타이핑 종료 |
| `location_update` | `{ latitude, longitude, accuracy }` | 위치 실시간 업데이트 |

### 서버 → 클라이언트 이벤트

| 이벤트 | 데이터 | 설명 |
|--------|--------|------|
| `new_message` | 메시지 객체 | 새 채팅 메시지 수신 |
| `message_read` | `{ message_id, user_id, read_at }` | 읽음 확인 |
| `user_typing` | `{ room_id, user_id, name }` | 상대방 타이핑 중 |
| `location_updated` | `{ senior_id, latitude, longitude, safe_zone }` | 노인 위치 변경 |
| `health_alert` | `{ senior_id, type, severity, value }` | 건강 이상 알림 |
| `safe_zone_alert` | `{ senior_id, zone_name, event: 'enter'/'exit' }` | 안전구역 이탈/진입 |
| `emergency_sos` | `{ event_id, senior_id, latitude, longitude }` | SOS 신호 수신 |
| `emergency_resolved` | `{ event_id, resolved_by }` | 응급 상황 해제 |
| `medication_reminder` | `{ schedule_id, med_name, scheduled_at }` | 복약 알림 |

---

## 에러 코드 목록

| 코드 | HTTP | 설명 |
|------|------|------|
| `INVALID_PHONE` | 400 | 잘못된 전화번호 |
| `OTP_RATE_LIMIT` | 429 | OTP 재발송 제한 |
| `OTP_INVALID` | 400 | OTP 불일치 |
| `OTP_EXPIRED` | 400 | OTP 만료 |
| `OTP_MAX_ATTEMPTS` | 429 | OTP 시도 횟수 초과 |
| `TOKEN_INVALID` | 401 | 유효하지 않은 토큰 |
| `TOKEN_EXPIRED` | 401 | 토큰 만료 |
| `USER_NOT_FOUND` | 404 | 사용자 없음 |
| `USER_ALREADY_EXISTS` | 409 | 이미 가입된 전화번호 |
| `RELATIONSHIP_NOT_FOUND` | 404 | 관계 없음 |
| `RELATIONSHIP_ALREADY_EXISTS` | 409 | 이미 연결된 관계 |
| `INVITE_CODE_INVALID` | 400 | 초대 코드 불일치/만료 |
| `HEALTH_RECORD_NOT_FOUND` | 404 | 건강 기록 없음 |
| `MEDICATION_NOT_FOUND` | 404 | 복약 일정 없음 |
| `SAFE_ZONE_NOT_FOUND` | 404 | 안전구역 없음 |
| `SAFE_ZONE_LIMIT_EXCEEDED` | 422 | 안전구역 최대 10개 |
| `CHAT_ROOM_NOT_FOUND` | 404 | 채팅방 없음 |
| `MESSAGE_NOT_FOUND` | 404 | 메시지 없음 |
| `EMERGENCY_NOT_FOUND` | 404 | 응급 이벤트 없음 |
| `PERMISSION_DENIED` | 403 | 권한 없음 |
| `UPLOAD_SIZE_EXCEEDED` | 422 | 파일 크기 초과 (이미지 10MB, 음성 20MB) |
| `INVALID_MEDIA_TYPE` | 422 | 허용되지 않는 파일 형식 |
| `RATE_LIMIT_EXCEEDED` | 429 | 요청 한도 초과 |
| `INTERNAL_ERROR` | 500 | 서버 내부 오류 |

---

## Rate Limiting 정책

| 엔드포인트 | 제한 |
|-----------|------|
| POST /auth/send-otp | 5 req/phone/hour |
| POST /auth/verify-otp | 5 req/phone/15min |
| POST /emergency/sos | 10 req/user/hour |
| POST /location/update | 60 req/user/hour |
| 일반 API | 100 req/user/min |

---

## Swagger 파일 위치

실제 OpenAPI 3.0 YAML 파일: `/root/.hermes/projects/senior-care/openapi.yaml`  
개발 서버 Swagger UI: `http://localhost:3000/api-docs`
