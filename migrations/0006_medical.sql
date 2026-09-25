-- 医療費の領収書（Phase 6）
-- 実行: npx wrangler d1 execute discord-calendar-bot --remote --file=migrations/0006_medical.sql

-- フォーラムの投稿（スレッド）ごとに、どこまで確認したか
CREATE TABLE IF NOT EXISTS medical_threads (
  thread_id        TEXT PRIMARY KEY,
  last_message_id  TEXT NOT NULL
);

-- 領収書1枚（添付ファイル1つ、または写真のない投稿の本文）＝1行
CREATE TABLE IF NOT EXISTS medical_receipts (
  receipt_id     TEXT PRIMARY KEY,               -- 添付ファイルの ID（本文だけの投稿は text-メッセージID）
  message_id     TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  filename       TEXT,
  status         TEXT NOT NULL,                  -- processing / done / error / skipped
  attempts       INTEGER NOT NULL DEFAULT 0,
  patient        TEXT,                           -- 医療を受けた人
  payee          TEXT,                           -- 病院・薬局などの支払先
  category       TEXT,                           -- 診療・治療 / 医薬品購入 / 介護保険サービス / その他の医療費
  amount         INTEGER,
  paid_date      TEXT,                           -- 支払年月日（YYYY-MM-DD）
  notes          TEXT,
  ocr_text       TEXT,
  year           INTEGER,
  sheet_id       TEXT,
  sheet_row      INTEGER,
  drive_file_id  TEXT,
  drive_name     TEXT,
  error          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
