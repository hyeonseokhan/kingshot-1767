-- kingshot_users v2 필드 확장
--
-- v2 = kingshot.jeab.dev (커뮤니티 트래커)
-- v1(공식 API) 에 없던 전투력·연맹·미스틱 데이터를 nullable 로 추가.
-- 기존 데이터는 NULL 유지 → 완전 backward compatible.
-- city_level 컬럼은 v2 town_hall_level 값으로 채워지도록 EF 호출부만 교체.

-- ─── 1. 신규 nullable 컬럼 ─────────────────────────────────────────

ALTER TABLE kingshot_users
  ADD COLUMN IF NOT EXISTS state                   INTEGER,        -- 왕국 번호
  ADD COLUMN IF NOT EXISTS power                   BIGINT,         -- 전투력
  ADD COLUMN IF NOT EXISTS life_tree_level         SMALLINT,       -- 생명의 나무 레벨
  ADD COLUMN IF NOT EXISTS alliance_id             BIGINT,         -- 연맹 ID
  ADD COLUMN IF NOT EXISTS alliance_abbr           TEXT,           -- 연맹 약어 (e.g. "SHP")
  ADD COLUMN IF NOT EXISTS alliance_name           TEXT,           -- 연맹 전체명
  ADD COLUMN IF NOT EXISTS alliance_rank           SMALLINT,       -- 연맹 내 직책 등급
  ADD COLUMN IF NOT EXISTS mystic_trial_score      INTEGER,        -- 미스틱 트라이얼 점수
  ADD COLUMN IF NOT EXISTS mystic_trial_rank       INTEGER,        -- 미스틱 트라이얼 순위
  ADD COLUMN IF NOT EXISTS mystic_trial_kid        INTEGER,        -- 미스틱 참여 왕국 번호
  ADD COLUMN IF NOT EXISTS mystic_trial_updated_ts BIGINT,         -- 미스틱 점수 업데이트 (Unix)
  ADD COLUMN IF NOT EXISTS v2_tag                  TEXT,           -- 커뮤니티 태그 (GOAT/KING/RAT 등)
  ADD COLUMN IF NOT EXISTS v2_last_refreshed_at    TIMESTAMPTZ;    -- v2 마지막 데이터 동기화 시각

-- ─── 2. kvk_speedup_survey VIEW 재정의 — v2 컬럼 노출 ──────────────

-- CREATE OR REPLACE VIEW 는 기존 컬럼 순서를 변경할 수 없음 →
-- 트리거 → VIEW 순으로 DROP 후 재생성.
DROP TRIGGER IF EXISTS kvk_speedup_survey_instead_of_insert ON kvk_speedup_survey;
DROP TRIGGER IF EXISTS kvk_speedup_survey_instead_of_update ON kvk_speedup_survey;
DROP TRIGGER IF EXISTS kvk_speedup_survey_instead_of_delete ON kvk_speedup_survey;
DROP VIEW IF EXISTS kvk_speedup_survey;

CREATE VIEW kvk_speedup_survey
WITH (security_invoker = true)
AS
SELECT
  -- 기존 컬럼 (순서 유지)
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
  ke.updated_at,
  -- v2 확장 필드 (뒤에 추가)
  ku.state,
  ku.power,
  ku.life_tree_level,
  ku.alliance_id,
  ku.alliance_abbr,
  ku.alliance_name,
  ku.alliance_rank,
  ku.mystic_trial_score,
  ku.mystic_trial_rank,
  ku.mystic_trial_kid,
  ku.mystic_trial_updated_ts,
  ku.v2_tag,
  ku.v2_last_refreshed_at
FROM kingshot_users ku
INNER JOIN kvk_survey_entries ke ON ke.kingshot_id = ku.kingshot_id;

-- DROP 으로 트리거도 사라지므로 재생성
CREATE TRIGGER kvk_speedup_survey_instead_of_insert
  INSTEAD OF INSERT ON kvk_speedup_survey
  FOR EACH ROW
  EXECUTE FUNCTION _kvk_survey_view_insert();

CREATE TRIGGER kvk_speedup_survey_instead_of_update
  INSTEAD OF UPDATE ON kvk_speedup_survey
  FOR EACH ROW
  EXECUTE FUNCTION _kvk_survey_view_update();

CREATE TRIGGER kvk_speedup_survey_instead_of_delete
  INSTEAD OF DELETE ON kvk_speedup_survey
  FOR EACH ROW
  EXECUTE FUNCTION _kvk_survey_view_delete();

-- ─── 3. INSTEAD OF INSERT 트리거 — v2 컬럼 포함 ─────────────────────

CREATE OR REPLACE FUNCTION _kvk_survey_view_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO kingshot_users (
    kingshot_id, nickname, avatar_url, city_level, is_admin,
    pin_hash, pin_salt, session_token, session_expires_at,
    state, power, life_tree_level,
    alliance_id, alliance_abbr, alliance_name, alliance_rank,
    mystic_trial_score, mystic_trial_rank, mystic_trial_kid, mystic_trial_updated_ts,
    v2_tag, v2_last_refreshed_at
  ) VALUES (
    NEW.kingshot_id,
    COALESCE(NEW.nickname, ''),
    NEW.avatar_url,
    NEW.city_level,
    COALESCE(NEW.is_admin, FALSE),
    NEW.pin_hash,
    NEW.pin_salt,
    NEW.session_token,
    NEW.session_expires_at,
    NEW.state,
    NEW.power,
    NEW.life_tree_level,
    NEW.alliance_id,
    NEW.alliance_abbr,
    NEW.alliance_name,
    NEW.alliance_rank,
    NEW.mystic_trial_score,
    NEW.mystic_trial_rank,
    NEW.mystic_trial_kid,
    NEW.mystic_trial_updated_ts,
    NEW.v2_tag,
    NEW.v2_last_refreshed_at
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

-- ─── 4. INSTEAD OF UPDATE 트리거 — v2 컬럼 포함 ─────────────────────

CREATE OR REPLACE FUNCTION _kvk_survey_view_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE kingshot_users SET
    nickname                 = NEW.nickname,
    avatar_url               = NEW.avatar_url,
    city_level               = NEW.city_level,
    is_admin                 = NEW.is_admin,
    pin_hash                 = NEW.pin_hash,
    pin_salt                 = NEW.pin_salt,
    session_token            = NEW.session_token,
    session_expires_at       = NEW.session_expires_at,
    state                    = NEW.state,
    power                    = NEW.power,
    life_tree_level          = NEW.life_tree_level,
    alliance_id              = NEW.alliance_id,
    alliance_abbr            = NEW.alliance_abbr,
    alliance_name            = NEW.alliance_name,
    alliance_rank            = NEW.alliance_rank,
    mystic_trial_score       = NEW.mystic_trial_score,
    mystic_trial_rank        = NEW.mystic_trial_rank,
    mystic_trial_kid         = NEW.mystic_trial_kid,
    mystic_trial_updated_ts  = NEW.mystic_trial_updated_ts,
    v2_tag                   = NEW.v2_tag,
    v2_last_refreshed_at     = NEW.v2_last_refreshed_at
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
