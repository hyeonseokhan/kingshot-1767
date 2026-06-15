-- 전략 채팅 — strategy_chat 테이블 + last_chat_at 레이트리밋 컬럼.

-- 5분 레이트 리밋 추적용 컬럼
ALTER TABLE kingshot_users
  ADD COLUMN IF NOT EXISTS last_chat_at TIMESTAMPTZ;

-- 전략 채팅 메시지 테이블
CREATE TABLE strategy_chat (
  id          BIGSERIAL    PRIMARY KEY,
  kingshot_id TEXT         NOT NULL REFERENCES kingshot_users (kingshot_id) ON DELETE CASCADE,
  nickname    TEXT         NOT NULL,
  avatar_url  TEXT,
  message     TEXT         NOT NULL CHECK (char_length(message) BETWEEN 1 AND 200),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE strategy_chat ENABLE ROW LEVEL SECURITY;

-- 공개 읽기: 전략 페이지 접속자면 채팅 내용 열람 가능
-- (페이지 자체가 verify-access 로 이미 KvK 멤버임을 검증하므로 RLS 는 단순 공개)
CREATE POLICY "strategy_chat_select_public"
  ON strategy_chat FOR SELECT USING (true);

-- 최신순 조회 인덱스
CREATE INDEX strategy_chat_created_at_idx ON strategy_chat (created_at DESC);

-- Supabase Realtime 활성화 (클라이언트 실시간 수신)
ALTER PUBLICATION supabase_realtime ADD TABLE strategy_chat;
