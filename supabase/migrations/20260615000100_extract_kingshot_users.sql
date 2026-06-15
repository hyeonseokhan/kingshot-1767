-- 인증 도메인 분리 — 킹샷 유저 통합 인증 테이블 신설.
--
-- 배경:
--   kvk_speedup_survey 가 인증(pin_hash, session_token)과 설문 참여(training, construction…)를
--   한 테이블에 섞어 저장해 서비스 간 혼동을 유발했음.
--
-- 변경 내용:
--   1. kingshot_users    — 통합 인증·신원 테이블 (PIN, 세션 토큰, 프로필)
--   2. kvk_survey_entries — KvK 설문 참여 전용 테이블 (가속권 데이터, IP 등)
--   3. kvk_speedup_survey → RENAME → _kvk_speedup_survey_old (백업)
--   4. kvk_speedup_survey VIEW 신설 — INNER JOIN, security_invoker
--      + INSTEAD OF INSERT/UPDATE/DELETE 트리거로 기존 EF 무수정 호환
--   5. kvk_buff_participants / _test FK → kingshot_users 로 재지정
--   6. strategy_admins FK → members → kingshot_users 로 교체

-- ─── 1. kingshot_users ───────────────────────────────────────────

CREATE TABLE kingshot_users (
  kingshot_id        TEXT NOT NULL PRIMARY KEY,
  nickname           TEXT NOT NULL DEFAULT '',
  avatar_url         TEXT,
  city_level         SMALLINT,
  is_admin           BOOLEAN NOT NULL DEFAULT FALSE,
  pin_hash           TEXT NOT NULL,
  pin_salt           TEXT NOT NULL,
  session_token      TEXT UNIQUE,
  session_expires_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER kingshot_users_updated_at
  BEFORE UPDATE ON kingshot_users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE kingshot_users ENABLE ROW LEVEL SECURITY;
-- 정책 0개 = anon 완전 차단; service_role 은 BYPASSRLS

CREATE INDEX kingshot_users_session_token_idx
  ON kingshot_users (session_token)
  WHERE session_token IS NOT NULL;

CREATE INDEX kingshot_users_created_at_idx
  ON kingshot_users (created_at DESC);

-- ─── 2. kvk_survey_entries ───────────────────────────────────────

CREATE TABLE kvk_survey_entries (
  kingshot_id          TEXT NOT NULL PRIMARY KEY
                         REFERENCES kingshot_users(kingshot_id) ON DELETE CASCADE,
  training             INTEGER NOT NULL DEFAULT 0,
  construction         INTEGER NOT NULL DEFAULT 0,
  general              INTEGER NOT NULL DEFAULT 0,
  ip                   TEXT,
  country              TEXT,
  platform             TEXT,
  evidence_uploaded_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER kvk_survey_entries_updated_at
  BEFORE UPDATE ON kvk_survey_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE kvk_survey_entries ENABLE ROW LEVEL SECURITY;

-- ─── 3. 데이터 이관 ───────────────────────────────────────────────

INSERT INTO kingshot_users (
  kingshot_id, nickname, avatar_url, city_level, is_admin,
  pin_hash, pin_salt, session_token, session_expires_at,
  created_at, updated_at
)
SELECT
  kingshot_id,
  COALESCE(nickname, ''),
  avatar_url,
  city_level,
  COALESCE(is_admin, FALSE),
  pin_hash,
  pin_salt,
  session_token,
  session_expires_at,
  created_at,
  updated_at
FROM kvk_speedup_survey;

INSERT INTO kvk_survey_entries (
  kingshot_id, training, construction, general,
  ip, country, platform, evidence_uploaded_at,
  created_at, updated_at
)
SELECT
  kingshot_id,
  COALESCE(training, 0),
  COALESCE(construction, 0),
  COALESCE(general, 0),
  ip,
  country,
  platform,
  evidence_uploaded_at,
  created_at,
  updated_at
FROM kvk_speedup_survey;

-- ─── 4. FK 재지정 ────────────────────────────────────────────────

-- kvk_buff_participants
ALTER TABLE kvk_buff_participants
  DROP CONSTRAINT kvk_buff_participants_kingshot_id_fkey;

ALTER TABLE kvk_buff_participants
  ADD CONSTRAINT kvk_buff_participants_kingshot_id_fkey
    FOREIGN KEY (kingshot_id) REFERENCES kingshot_users(kingshot_id) ON DELETE CASCADE;

-- kvk_buff_participants_test
ALTER TABLE kvk_buff_participants_test
  DROP CONSTRAINT kvk_buff_participants_test_kingshot_id_fkey;

ALTER TABLE kvk_buff_participants_test
  ADD CONSTRAINT kvk_buff_participants_test_kingshot_id_fkey
    FOREIGN KEY (kingshot_id) REFERENCES kingshot_users(kingshot_id) ON DELETE CASCADE;

-- strategy_admins: members → kingshot_users
ALTER TABLE strategy_admins
  DROP CONSTRAINT strategy_admins_kingshot_id_fkey;

ALTER TABLE strategy_admins
  ADD CONSTRAINT strategy_admins_kingshot_id_fkey
    FOREIGN KEY (kingshot_id) REFERENCES kingshot_users(kingshot_id) ON DELETE CASCADE;

-- ─── 5. 기존 테이블 백업 이름으로 보관 ───────────────────────────

ALTER TABLE kvk_speedup_survey RENAME TO _kvk_speedup_survey_old;

-- ─── 6. kvk_speedup_survey VIEW 신설 ────────────────────────────
--
-- INNER JOIN 이므로 설문 참여자(kvk_survey_entries 행 존재)만 노출.
-- security_invoker = true → anon 접근 시 기반 테이블 RLS 적용 (anon 차단).

CREATE VIEW kvk_speedup_survey
WITH (security_invoker = true)
AS
SELECT
  ku.kingshot_id,
  ku.nickname,
  ku.avatar_url,
  ku.city_level,
  ku.is_admin,
  ku.pin_hash,
  ku.pin_salt,
  ku.session_token,
  ku.session_expires_at,
  ke.training,
  ke.construction,
  ke.general,
  ke.ip,
  ke.country,
  ke.platform,
  ke.evidence_uploaded_at,
  ke.created_at,
  ke.updated_at
FROM kingshot_users ku
INNER JOIN kvk_survey_entries ke ON ke.kingshot_id = ku.kingshot_id;

-- ─── 7. INSTEAD OF INSERT ────────────────────────────────────────

CREATE OR REPLACE FUNCTION _kvk_survey_view_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO kingshot_users (
    kingshot_id, nickname, avatar_url, city_level, is_admin,
    pin_hash, pin_salt, session_token, session_expires_at
  ) VALUES (
    NEW.kingshot_id,
    COALESCE(NEW.nickname, ''),
    NEW.avatar_url,
    NEW.city_level,
    COALESCE(NEW.is_admin, FALSE),
    NEW.pin_hash,
    NEW.pin_salt,
    NEW.session_token,
    NEW.session_expires_at
  );

  INSERT INTO kvk_survey_entries (
    kingshot_id, training, construction, general,
    ip, country, platform
  ) VALUES (
    NEW.kingshot_id,
    COALESCE(NEW.training, 0),
    COALESCE(NEW.construction, 0),
    COALESCE(NEW.general, 0),
    NEW.ip,
    NEW.country,
    NEW.platform
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER kvk_speedup_survey_instead_of_insert
  INSTEAD OF INSERT ON kvk_speedup_survey
  FOR EACH ROW
  EXECUTE FUNCTION _kvk_survey_view_insert();

-- ─── 8. INSTEAD OF UPDATE ────────────────────────────────────────

CREATE OR REPLACE FUNCTION _kvk_survey_view_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE kingshot_users SET
    nickname           = NEW.nickname,
    avatar_url         = NEW.avatar_url,
    city_level         = NEW.city_level,
    is_admin           = NEW.is_admin,
    pin_hash           = NEW.pin_hash,
    pin_salt           = NEW.pin_salt,
    session_token      = NEW.session_token,
    session_expires_at = NEW.session_expires_at
  WHERE kingshot_id = OLD.kingshot_id;

  UPDATE kvk_survey_entries SET
    training             = NEW.training,
    construction         = NEW.construction,
    general              = NEW.general,
    ip                   = NEW.ip,
    country              = NEW.country,
    platform             = NEW.platform,
    evidence_uploaded_at = NEW.evidence_uploaded_at
  WHERE kingshot_id = OLD.kingshot_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER kvk_speedup_survey_instead_of_update
  INSTEAD OF UPDATE ON kvk_speedup_survey
  FOR EACH ROW
  EXECUTE FUNCTION _kvk_survey_view_update();

-- ─── 9. INSTEAD OF DELETE ────────────────────────────────────────

CREATE OR REPLACE FUNCTION _kvk_survey_view_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- kvk_survey_entries 가 kingshot_users 를 FK 참조하므로 항목부터 삭제
  DELETE FROM kvk_survey_entries WHERE kingshot_id = OLD.kingshot_id;
  DELETE FROM kingshot_users     WHERE kingshot_id = OLD.kingshot_id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER kvk_speedup_survey_instead_of_delete
  INSTEAD OF DELETE ON kvk_speedup_survey
  FOR EACH ROW
  EXECUTE FUNCTION _kvk_survey_view_delete();
