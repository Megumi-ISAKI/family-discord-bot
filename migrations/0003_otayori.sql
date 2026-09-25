-- おたよりOCR（Phase 3）
-- 実行: npx wrangler d1 execute discord-calendar-bot --remote --file=migrations/0003_otayori.sql

-- フォーラムの投稿（スレッド）ごとに、どこまで確認したか
CREATE TABLE IF NOT EXISTS otayori_threads (
  thread_id        TEXT PRIMARY KEY,
  last_message_id  TEXT NOT NULL
);

-- 添付ファイルごとの処理状況（同じファイルを二度 OCR しないため）
CREATE TABLE IF NOT EXISTS otayori_files (
  attachment_id  TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  filename       TEXT NOT NULL,
  status         TEXT NOT NULL,                  -- processing / done / error / skipped
  attempts       INTEGER NOT NULL DEFAULT 0,
  title          TEXT,
  ocr_text       TEXT,
  drive_file_id  TEXT,
  drive_name     TEXT,
  error          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 設定値（おたよりOCRを始めた時点など）
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
