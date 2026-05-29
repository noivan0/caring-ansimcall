--
-- PostgreSQL database dump
--


-- Dumped from database version 14.22 (Ubuntu 14.22-0ubuntu0.22.04.1)
-- Dumped by pg_dump version 14.22 (Ubuntu 14.22-0ubuntu0.22.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid,
    sender_id uuid,
    type character varying(20) DEFAULT 'text'::character varying NOT NULL,
    content text,
    media_url character varying(500),
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT chat_messages_type_check CHECK (((type)::text = ANY ((ARRAY['text'::character varying, 'image'::character varying, 'voice'::character varying, 'location'::character varying, 'emergency'::character varying])::text[])))
);


ALTER TABLE public.chat_messages OWNER TO postgres;

--
-- Name: chat_participants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.chat_participants (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.chat_participants OWNER TO postgres;

--
-- Name: chat_read_receipts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.chat_read_receipts (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    message_id uuid,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.chat_read_receipts OWNER TO postgres;

--
-- Name: chat_rooms; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.chat_rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type character varying(20) NOT NULL,
    name character varying(200),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_rooms_type_check CHECK (((type)::text = ANY ((ARRAY['direct'::character varying, 'family'::character varying])::text[])))
);


ALTER TABLE public.chat_rooms OWNER TO postgres;

--
-- Name: elders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.elders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    display_name character varying(100) NOT NULL,
    birth_date date,
    medical_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.elders OWNER TO postgres;

--
-- Name: emergency_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.emergency_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    elder_id uuid,
    trigger_type character varying(30) DEFAULT 'button'::character varying NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    triggered_by uuid,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    resolve_note text,
    emergency_119_ref character varying(100),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT emergency_events_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'acknowledged'::character varying, 'resolved'::character varying])::text[]))),
    CONSTRAINT emergency_events_trigger_type_check CHECK (((trigger_type)::text = ANY ((ARRAY['button'::character varying, 'fall_detected'::character varying, 'no_movement'::character varying])::text[])))
);


ALTER TABLE public.emergency_events OWNER TO postgres;

--
-- Name: guardian_relationships; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.guardian_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guardian_user_id uuid,
    elder_id uuid,
    relationship_type character varying(30) NOT NULL,
    consent_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guardian_relationships_consent_status_check CHECK (((consent_status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT guardian_relationships_relationship_type_check CHECK (((relationship_type)::text = ANY ((ARRAY['child'::character varying, 'spouse'::character varying, 'sibling'::character varying, 'caregiver'::character varying, 'other'::character varying])::text[])))
);


ALTER TABLE public.guardian_relationships OWNER TO postgres;

--
-- Name: health_thresholds; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.health_thresholds (
    elder_id uuid NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.health_thresholds OWNER TO postgres;

--
-- Name: location_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.location_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    elder_id uuid,
    latitude numeric(10,7) NOT NULL,
    longitude numeric(10,7) NOT NULL,
    accuracy numeric(6,2),
    altitude numeric(8,2),
    speed numeric(6,2),
    is_in_safe_zone boolean DEFAULT false NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.location_logs OWNER TO postgres;

--
-- Name: medication_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.medication_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid,
    elder_id uuid,
    status character varying(20) NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    logged_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT medication_logs_status_check CHECK (((status)::text = ANY ((ARRAY['taken'::character varying, 'missed'::character varying, 'skipped'::character varying])::text[])))
);


ALTER TABLE public.medication_logs OWNER TO postgres;

--
-- Name: medication_schedules; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.medication_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    elder_id uuid,
    medication_name character varying(200) NOT NULL,
    dosage character varying(100) NOT NULL,
    frequency character varying(30) NOT NULL,
    scheduled_times text[] NOT NULL,
    repeat_days smallint[] DEFAULT '{1,2,3,4,5,6,7}'::smallint[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT medication_schedules_frequency_check CHECK (((frequency)::text = ANY ((ARRAY['daily'::character varying, 'twice_daily'::character varying, 'three_times'::character varying, 'weekly'::character varying, 'as_needed'::character varying])::text[])))
);


ALTER TABLE public.medication_schedules OWNER TO postgres;

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    type character varying(100) NOT NULL,
    title character varying(300) NOT NULL,
    body text,
    data jsonb,
    is_read boolean DEFAULT false NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.notifications OWNER TO postgres;

--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.refresh_tokens OWNER TO postgres;

--
-- Name: safe_zones; Type: TABLE; Schema: public; Owner: caring
--

CREATE TABLE public.safe_zones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    elder_id uuid,
    name character varying(100) NOT NULL,
    latitude numeric(10,7) NOT NULL,
    longitude numeric(10,7) NOT NULL,
    radius_meters integer DEFAULT 200,
    icon character varying(20) DEFAULT 'other'::character varying,
    created_by uuid,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.safe_zones OWNER TO caring;

--
-- Name: saju_readings; Type: TABLE; Schema: public; Owner: caring
--

CREATE TABLE public.saju_readings (
    id integer NOT NULL,
    session_id character varying(64) NOT NULL,
    birth_year integer,
    birth_month integer,
    birth_day integer,
    birth_hour integer,
    gender character varying(10),
    day_pillar character varying(10),
    primary_element character varying(5),
    pillars_json jsonb,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.saju_readings OWNER TO caring;

--
-- Name: saju_readings_id_seq; Type: SEQUENCE; Schema: public; Owner: caring
--

CREATE SEQUENCE public.saju_readings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.saju_readings_id_seq OWNER TO caring;

--
-- Name: saju_readings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: caring
--

ALTER SEQUENCE public.saju_readings_id_seq OWNED BY public.saju_readings.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    phone character varying(20),
    password_hash text NOT NULL,
    display_name character varying(100) NOT NULL,
    role character varying(20) NOT NULL,
    profile_image_url character varying(500),
    fcm_token character varying(500),
    is_deleted boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['elder'::character varying, 'guardian'::character varying])::text[])))
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: vitals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.vitals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    elder_id uuid,
    blood_pressure_systolic smallint,
    blood_pressure_diastolic smallint,
    blood_glucose numeric(6,2),
    heart_rate smallint,
    steps integer,
    source character varying(30) NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vitals_source_check CHECK (((source)::text = ANY ((ARRAY['smartwatch'::character varying, 'blood_pressure_cuff'::character varying, 'glucometer'::character varying, 'manual'::character varying, 'app'::character varying])::text[])))
);


ALTER TABLE public.vitals OWNER TO postgres;

--
-- Name: saju_readings id; Type: DEFAULT; Schema: public; Owner: caring
--

ALTER TABLE ONLY public.saju_readings ALTER COLUMN id SET DEFAULT nextval('public.saju_readings_id_seq'::regclass);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_participants chat_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_participants
    ADD CONSTRAINT chat_participants_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: chat_read_receipts chat_read_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_read_receipts
    ADD CONSTRAINT chat_read_receipts_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: chat_rooms chat_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_rooms
    ADD CONSTRAINT chat_rooms_pkey PRIMARY KEY (id);


--
-- Name: elders elders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.elders
    ADD CONSTRAINT elders_pkey PRIMARY KEY (id);


--
-- Name: elders elders_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.elders
    ADD CONSTRAINT elders_user_id_key UNIQUE (user_id);


--
-- Name: emergency_events emergency_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.emergency_events
    ADD CONSTRAINT emergency_events_pkey PRIMARY KEY (id);


--
-- Name: guardian_relationships guardian_relationships_guardian_user_id_elder_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.guardian_relationships
    ADD CONSTRAINT guardian_relationships_guardian_user_id_elder_id_key UNIQUE (guardian_user_id, elder_id);


--
-- Name: guardian_relationships guardian_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.guardian_relationships
    ADD CONSTRAINT guardian_relationships_pkey PRIMARY KEY (id);


--
-- Name: health_thresholds health_thresholds_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.health_thresholds
    ADD CONSTRAINT health_thresholds_pkey PRIMARY KEY (elder_id);


--
-- Name: location_logs location_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.location_logs
    ADD CONSTRAINT location_logs_pkey PRIMARY KEY (id);


--
-- Name: medication_logs medication_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.medication_logs
    ADD CONSTRAINT medication_logs_pkey PRIMARY KEY (id);


--
-- Name: medication_schedules medication_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.medication_schedules
    ADD CONSTRAINT medication_schedules_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_user_id_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_token_hash_key UNIQUE (user_id, token_hash);


--
-- Name: safe_zones safe_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: caring
--

ALTER TABLE ONLY public.safe_zones
    ADD CONSTRAINT safe_zones_pkey PRIMARY KEY (id);


--
-- Name: saju_readings saju_readings_pkey; Type: CONSTRAINT; Schema: public; Owner: caring
--

ALTER TABLE ONLY public.saju_readings
    ADD CONSTRAINT saju_readings_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vitals vitals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vitals
    ADD CONSTRAINT vitals_pkey PRIMARY KEY (id);


--
-- Name: idx_chat_messages_room; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_chat_messages_room ON public.chat_messages USING btree (room_id, sent_at DESC);


--
-- Name: idx_emergency_elder_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_emergency_elder_active ON public.emergency_events USING btree (elder_id, status, triggered_at DESC);


--
-- Name: idx_guardian_rel_elder; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_guardian_rel_elder ON public.guardian_relationships USING btree (elder_id, consent_status);


--
-- Name: idx_guardian_rel_guardian; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_guardian_rel_guardian ON public.guardian_relationships USING btree (guardian_user_id, consent_status);


--
-- Name: idx_location_elder_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_location_elder_time ON public.location_logs USING btree (elder_id, recorded_at DESC);


--
-- Name: idx_med_logs_elder_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_med_logs_elder_date ON public.medication_logs USING btree (elder_id, taken_at DESC);


--
-- Name: idx_med_schedule_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_med_schedule_active ON public.medication_schedules USING btree (elder_id) WHERE (is_active = true);


--
-- Name: idx_notifications_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id, is_read, sent_at DESC);


--
-- Name: idx_saju_session; Type: INDEX; Schema: public; Owner: caring
--

CREATE INDEX idx_saju_session ON public.saju_readings USING btree (session_id);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_email ON public.users USING btree (email) WHERE (is_deleted = false);


--
-- Name: idx_users_phone; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_phone ON public.users USING btree (phone) WHERE (is_deleted = false);


--
-- Name: idx_vitals_elder_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_vitals_elder_time ON public.vitals USING btree (elder_id, recorded_at DESC);


--
-- Name: chat_messages chat_messages_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.chat_rooms(id);


--
-- Name: chat_messages chat_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id);


--
-- Name: chat_participants chat_participants_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_participants
    ADD CONSTRAINT chat_participants_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.chat_rooms(id) ON DELETE CASCADE;


--
-- Name: chat_participants chat_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_participants
    ADD CONSTRAINT chat_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: chat_read_receipts chat_read_receipts_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_read_receipts
    ADD CONSTRAINT chat_read_receipts_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.chat_messages(id);


--
-- Name: chat_read_receipts chat_read_receipts_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_read_receipts
    ADD CONSTRAINT chat_read_receipts_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.chat_rooms(id);


--
-- Name: chat_read_receipts chat_read_receipts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.chat_read_receipts
    ADD CONSTRAINT chat_read_receipts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: elders elders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.elders
    ADD CONSTRAINT elders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: emergency_events emergency_events_elder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.emergency_events
    ADD CONSTRAINT emergency_events_elder_id_fkey FOREIGN KEY (elder_id) REFERENCES public.elders(id);


--
-- Name: emergency_events emergency_events_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.emergency_events
    ADD CONSTRAINT emergency_events_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: emergency_events emergency_events_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.emergency_events
    ADD CONSTRAINT emergency_events_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id);


--
-- Name: guardian_relationships guardian_relationships_elder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.guardian_relationships
    ADD CONSTRAINT guardian_relationships_elder_id_fkey FOREIGN KEY (elder_id) REFERENCES public.elders(id);


--
-- Name: guardian_relationships guardian_relationships_guardian_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.guardian_relationships
    ADD CONSTRAINT guardian_relationships_guardian_user_id_fkey FOREIGN KEY (guardian_user_id) REFERENCES public.users(id);


--
-- Name: health_thresholds health_thresholds_elder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.health_thresholds
    ADD CONSTRAINT health_thresholds_elder_id_fkey FOREIGN KEY (elder_id) REFERENCES public.elders(id);


--
-- Name: location_logs location_logs_elder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.location_logs
    ADD CONSTRAINT location_logs_elder_id_fkey FOREIGN KEY (elder_id) REFERENCES public.elders(id);


--
-- Name: medication_logs medication_logs_elder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.medication_logs
    ADD CONSTRAINT medication_logs_elder_id_fkey FOREIGN KEY (elder_id) REFERENCES public.elders(id);


--
-- Name: medication_logs medication_logs_logged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.medication_logs
    ADD CONSTRAINT medication_logs_logged_by_fkey FOREIGN KEY (logged_by) REFERENCES public.users(id);


--
-- Name: medication_logs medication_logs_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.medication_logs
    ADD CONSTRAINT medication_logs_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.medication_schedules(id);


--
-- Name: medication_schedules medication_schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.medication_schedules
    ADD CONSTRAINT medication_schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: medication_schedules medication_schedules_elder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.medication_schedules
    ADD CONSTRAINT medication_schedules_elder_id_fkey FOREIGN KEY (elder_id) REFERENCES public.elders(id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: safe_zones safe_zones_elder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: caring
--

ALTER TABLE ONLY public.safe_zones
    ADD CONSTRAINT safe_zones_elder_id_fkey FOREIGN KEY (elder_id) REFERENCES public.elders(id) ON DELETE CASCADE;


--
-- Name: vitals vitals_elder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.vitals
    ADD CONSTRAINT vitals_elder_id_fkey FOREIGN KEY (elder_id) REFERENCES public.elders(id);


--
-- Name: TABLE chat_messages; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.chat_messages TO caring;


--
-- Name: TABLE chat_participants; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.chat_participants TO caring;


--
-- Name: TABLE chat_read_receipts; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.chat_read_receipts TO caring;


--
-- Name: TABLE chat_rooms; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.chat_rooms TO caring;


--
-- Name: TABLE elders; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.elders TO caring;


--
-- Name: TABLE emergency_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.emergency_events TO caring;


--
-- Name: TABLE guardian_relationships; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.guardian_relationships TO caring;


--
-- Name: TABLE health_thresholds; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.health_thresholds TO caring;


--
-- Name: TABLE location_logs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.location_logs TO caring;


--
-- Name: TABLE medication_logs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.medication_logs TO caring;


--
-- Name: TABLE medication_schedules; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.medication_schedules TO caring;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.notifications TO caring;


--
-- Name: TABLE refresh_tokens; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.refresh_tokens TO caring;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.users TO caring;


--
-- Name: TABLE vitals; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.vitals TO caring;


--
-- PostgreSQL database dump complete
--

\unrestrict DlsxLRlGXNK32cQM71pcZ4XMj8lRkImjshJfKzp1v3mCjd8udD7Q29RGVrsJifW

