-- 請求書・支払い管理（Phase 5）
-- 実行: npx wrangler d1 execute discord-calendar-bot --remote --file=migrations/0005_bills.sql

-- 💸-請求書・支払い の投稿（スレッド）1件＝請求1件
CREATE TABLE IF NOT EXISTS bills (
  thread_id      TEXT PRIMARY KEY,               -- 投稿（スレッド）の ID。シートの「管理番号」列と同じ
  status         TEXT NOT NULL,                  -- processing / done / error
  attempts       INTEGER NOT NULL DEFAULT 0,
  title          TEXT,
  payee          TEXT,                           -- 支払い先
  amount         INTEGER,                        -- 金額（円）。不明なら NULL
  due_date       TEXT,                           -- 支払期限（YYYY-MM-DD）
  method         TEXT,                           -- 支払方法
  bank_info      TEXT,                           -- 振込先
  notes          TEXT,
  ocr_text       TEXT,
  paid           INTEGER NOT NULL DEFAULT 0,     -- 最後に同期したときの支払い状況（1 = 支払い済）
  error          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
