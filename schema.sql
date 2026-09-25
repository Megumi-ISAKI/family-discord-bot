-- 新しく作るとき用（npm run db:init）。既存のデータベースは migrations/ を適用する

CREATE TABLE IF NOT EXISTS members (
  user_id      TEXT PRIMARY KEY,                 -- Discord のユーザーID
  display_name TEXT NOT NULL,                    -- 投稿に表示する名前（登録時のサーバーニックネーム）
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 1人が複数のカレンダーを登録できる
CREATE TABLE IF NOT EXISTS calendars (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('google', 'ics')),
  source       TEXT NOT NULL,                    -- Google のカレンダーID、または ICS の URL
  label        TEXT NOT NULL,                    -- カレンダー名（投稿で［］内に表示）
  access_role  TEXT,                             -- owner / writer / reader / freeBusyReader / ics
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source)
);

-- おたよりOCR（Phase 3）
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

-- AIコンシェルジュ（Phase 4）
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

-- 請求書・支払い管理（Phase 5）
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

-- 医療費の領収書（Phase 6）
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
