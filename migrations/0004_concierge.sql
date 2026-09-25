-- AIコンシェルジュ（Phase 4）
-- 実行: npx wrangler d1 execute discord-calendar-bot --remote --file=migrations/0004_concierge.sql

-- 質問と回答の記録（回数の上限・利用額の計算・続けて質問したときの文脈に使う）
CREATE TABLE IF NOT EXISTS concierge_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT NOT NULL,
  question       TEXT NOT NULL,
  answer         TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS concierge_log_user ON concierge_log (user_id, created_at);
