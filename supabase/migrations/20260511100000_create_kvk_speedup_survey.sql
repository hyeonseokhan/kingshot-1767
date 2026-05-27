-- KVK 가속권 보유량 설문 테이블
--   * survey.kingshot.wooju-home.org/kvk 단일 페이지에서 사용
--   * PNX 연맹원 + 외부 유저 모두 참여 가능 → members 와 FK 분리
--   * 설문 전용 PIN (member_credentials 와 분리, 데이터 도메인 오염 차단)
--   * 사람당 1행, 덮어쓰기. 시즌 청소는 수동 (`TRUNCATE kvk_speedup_survey;`)
--
-- 외부 노출: anon 키 모든 작업 차단 (RLS 정책 0개).
-- list/register/update 전부 Edge Function `kvk-survey` (service_role) 통과.
CREATE TABLE IF NOT EXISTS kvk_speedup_survey (
  kingshot_id  TEXT PRIMARY KEY,
  nickname     TEXT NOT NULL,
  avatar_url   TEXT,
  pin_hash     TEXT NOT NULL,
  pin_salt     TEXT NOT NULL,
  training     INTEGER NOT NULL DEFAULT 0 CHECK (training >= 0),
  construction INTEGER NOT NULL DEFAULT 0 CHECK (construction >= 0),
  general      INTEGER NOT NULL DEFAULT 0 CHECK (general >= 0),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER kvk_speedup_survey_updated_at
  BEFORE UPDATE ON kvk_speedup_survey
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- 정렬 보조: 목록 페이지가 "공용 가속권 desc" 등 정렬 기본값으로 쓸 가능성 대비.
-- 데이터 규모(55명 수준) 작아서 시급하진 않으나 일관성 차원에서 created_at 1개만 추가.
CREATE INDEX IF NOT EXISTS idx_kvk_survey_created_at
  ON kvk_speedup_survey (created_at DESC);

-- RLS 활성화 + 정책 0개 = anon 차단. service_role (Edge Function) 만 접근.
ALTER TABLE kvk_speedup_survey ENABLE ROW LEVEL SECURITY;
