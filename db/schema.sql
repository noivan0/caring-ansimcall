-- ============================================================
--  노부모케어 PostgreSQL 스키마
--  파일: db/schema.sql
--  실행: psql -d senior_care_db -f db/schema.sql
-- ============================================================

-- 확장 (PostGIS — 위치 쿼리 최적화)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ── 1. 사용자 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            VARCHAR(255) UNIQUE NOT NULL,
  phone            VARCHAR(20)  UNIQUE NOT NULL,
  password_hash    TEXT NOT NULL,
  display_name     VARCHAR(100) NOT NULL,
  role             VARCHAR(20)  NOT NULL CHECK (role IN ('elder', 'guardian')),
  profile_image_url VARCHAR(500),
  fcm_token        VARCHAR(500),
  is_deleted       BOOLEAN NOT NULL DEFAULT false,
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE is_deleted = false;

-- ── 2. Refresh 토큰 (화이트리스트) ───────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, token_hash)
);

-- ── 3. 노인 프로필 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS elders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  birth_date   DATE,
  medical_note TEXT,  -- 기저질환 메모 (민감정보)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. 보호자-노인 관계 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS guardian_relationships (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_user_id  UUID REFERENCES users(id),
  elder_id          UUID REFERENCES elders(id),
  relationship_type VARCHAR(30) NOT NULL CHECK (
    relationship_type IN ('child','spouse','sibling','caregiver','other')
  ),
  consent_status    VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    consent_status IN ('pending','accepted','rejected')
  ),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guardian_user_id, elder_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_rel_elder ON guardian_relationships(elder_id, consent_status);
CREATE INDEX IF NOT EXISTS idx_guardian_rel_guardian ON guardian_relationships(guardian_user_id, consent_status);

-- ── 5. 바이탈 기록 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vitals (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  elder_id                    UUID REFERENCES elders(id),
  blood_pressure_systolic     SMALLINT,
  blood_pressure_diastolic    SMALLINT,
  blood_glucose               NUMERIC(6,2),
  heart_rate                  SMALLINT,
  steps                       INTEGER,
  source                      VARCHAR(30) NOT NULL CHECK (
    source IN ('smartwatch','blood_pressure_cuff','glucometer','manual','app')
  ),
  recorded_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vitals_elder_time ON vitals(elder_id, recorded_at DESC);

-- ── 6. 건강 임계값 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_thresholds (
  elder_id    UUID PRIMARY KEY REFERENCES elders(id),
  settings    JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 7. 복약 스케줄 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS medication_schedules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  elder_id         UUID REFERENCES elders(id),
  medication_name  VARCHAR(200) NOT NULL,
  dosage           VARCHAR(100) NOT NULL,
  frequency        VARCHAR(30) NOT NULL CHECK (
    frequency IN ('daily','twice_daily','three_times','weekly','as_needed')
  ),
  scheduled_times  TEXT[]  NOT NULL,  -- ['08:00','20:00']
  repeat_days      SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',  -- 1=월 ~ 7=일
  is_active        BOOLEAN NOT NULL DEFAULT true,
  reminded_at      TIMESTAMPTZ,                          -- 마지막 알림 발송 시각
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_med_schedule_active ON medication_schedules(elder_id) WHERE is_active = true;

-- ── 8. 복약 기록 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS medication_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id  UUID REFERENCES medication_schedules(id),
  elder_id     UUID REFERENCES elders(id),
  status       VARCHAR(20) NOT NULL CHECK (status IN ('taken','missed','skipped')),
  taken_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note         TEXT,
  logged_by    UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_med_logs_elder_date ON medication_logs(elder_id, taken_at DESC);

-- ── 9. 위치 기록 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  elder_id        UUID REFERENCES elders(id),
  latitude        NUMERIC(10,7) NOT NULL,
  longitude       NUMERIC(10,7) NOT NULL,
  accuracy        NUMERIC(6,2),
  altitude        NUMERIC(8,2),
  speed           NUMERIC(6,2),
  is_in_safe_zone BOOLEAN NOT NULL DEFAULT false,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_location_elder_time ON location_logs(elder_id, recorded_at DESC);

-- ── 10. 안전구역 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS safe_zones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  elder_id      UUID REFERENCES elders(id),
  name          VARCHAR(200) NOT NULL,
  center_point  geography(POINT, 4326) NOT NULL,
  radius_meters INTEGER NOT NULL DEFAULT 200,
  icon          VARCHAR(30) NOT NULL DEFAULT 'other' CHECK (
    icon IN ('home','hospital','store','park','other')
  ),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safe_zones_elder ON safe_zones(elder_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_safe_zones_geog ON safe_zones USING GIST (center_point);

-- ── 11. 채팅방 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_rooms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       VARCHAR(20) NOT NULL CHECK (type IN ('direct','family')),
  name       VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_participants (
  room_id    UUID REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID REFERENCES chat_rooms(id),
  sender_id  UUID REFERENCES users(id),
  type       VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (
    type IN ('text','image','voice','location','emergency')
  ),
  content    TEXT,
  media_url  VARCHAR(500),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS chat_read_receipts (
  room_id    UUID REFERENCES chat_rooms(id),
  user_id    UUID REFERENCES users(id),
  message_id UUID REFERENCES chat_messages(id),
  read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

-- ── 12. 응급 이벤트 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS emergency_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  elder_id            UUID REFERENCES elders(id),
  trigger_type        VARCHAR(30) NOT NULL DEFAULT 'button' CHECK (
    trigger_type IN ('button','fall_detected','no_movement')
  ),
  latitude            NUMERIC(10,7),
  longitude           NUMERIC(10,7),
  status              VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (
    status IN ('active','acknowledged','resolved')
  ),
  triggered_by        UUID REFERENCES users(id),
  triggered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by         UUID REFERENCES users(id),
  resolved_at         TIMESTAMPTZ,
  resolve_note        TEXT,
  emergency_119_ref   VARCHAR(100),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_emergency_elder_active ON emergency_events(elder_id, status, triggered_at DESC);

-- ── 13. 알림 이력 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  UUID REFERENCES users(id),
  type     VARCHAR(100) NOT NULL,
  title    VARCHAR(300) NOT NULL,
  body     TEXT,
  data     JSONB,
  is_read  BOOLEAN NOT NULL DEFAULT false,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, sent_at DESC);
