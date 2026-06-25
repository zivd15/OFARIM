-- Ofarim canonical schema — AUTO-GENERATED from the live production DB:
--   npm run db:export:prod   (wrangler d1 export ofarim --remote --no-data)
-- This is the authoritative final shape (includes all migrations 0001–0010).
-- SECURITY: no admin account is seeded here and there must be NEVER any default
-- credentials. Bootstrap the first admin once via POST /api/setup-admin
-- (gated by INIT_ADMIN_PASSWORD; refuses to run once any admin exists).
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT DEFAULT '',
  password TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
, otp_code TEXT, otp_expires_at TEXT, otp_attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  end_time TEXT DEFAULT '',
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  color TEXT DEFAULT '#3498db',
  max_participants INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
, current_participants INTEGER NOT NULL DEFAULT 0, price INTEGER NOT NULL DEFAULT 0, allow_couples INTEGER NOT NULL DEFAULT 0, couple_price  INTEGER NOT NULL DEFAULT 0, payment_link TEXT, confirmation_message TEXT, reminder_message TEXT);
CREATE TABLE participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  user_id INTEGER DEFAULT NULL,
  signed_at TEXT DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'confirmed', 'waitlisted', 'expired')), created_at TEXT, ticket_type TEXT NOT NULL DEFAULT 'single'
  CHECK (ticket_type IN ('single', 'couple')), spots INTEGER NOT NULL DEFAULT 1
  CHECK (spots IN (1, 2)), notes TEXT, reminder_sent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
DELETE FROM sqlite_sequence;
CREATE INDEX idx_events_date ON events(date);
CREATE INDEX idx_participants_event ON participants(event_id);
CREATE INDEX idx_participants_user ON participants(user_id);
CREATE INDEX idx_participants_status_created ON participants(status, created_at);
CREATE UNIQUE INDEX uniq_users_email
  ON users(email);
CREATE UNIQUE INDEX uniq_participants_user_event_active
  ON participants(event_id, user_id)
  WHERE user_id IS NOT NULL AND status != 'expired';

-- Migration 004: analytics page_views table
CREATE TABLE IF NOT EXISTS page_views (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page        TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  country     TEXT,
  referrer    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pv_created_at ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pv_session    ON page_views(session_id);
