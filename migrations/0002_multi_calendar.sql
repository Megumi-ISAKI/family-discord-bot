-- 1人1カレンダー（members に source を持つ形）から、複数カレンダー（calendars テーブル）へ移行する
-- 実行: npx wrangler d1 execute discord-calendar-bot --remote --file=migrations/0002_multi_calendar.sql

CREATE TABLE calendars (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('google', 'ics')),
  source       TEXT NOT NULL,
  label        TEXT NOT NULL,
  access_role  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source)
);

INSERT INTO calendars (user_id, kind, source, label, access_role, created_at)
  SELECT user_id, kind, source, CASE kind WHEN 'ics' THEN 'iCal' ELSE source END, access_role, created_at FROM members;

CREATE TABLE members_new (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO members_new (user_id, display_name, created_at, updated_at)
  SELECT user_id, display_name, created_at, updated_at FROM members;
DROP TABLE members;
ALTER TABLE members_new RENAME TO members;
