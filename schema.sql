-- Ofarim schema.
-- SECURITY: no admin account is seeded here. The schema MUST NOT contain any
-- default credentials. Bootstrap the first admin exactly once via
--   POST /api/setup-admin  { "secret": "<INIT_ADMIN_PASSWORD>", "email": ..., "password": ... }
-- which is gated by the INIT_ADMIN_PASSWORD environment secret and refuses to
-- run once any admin exists.

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT DEFAULT '',
  password TEXT NOT NULL DEFAULT '',   -- vestigial: users are passwordless (OTP). '' never matches verifyPassword.
  otp_code TEXT,                       -- current 6-digit login code (nullable; cleared on use)
  otp_expires_at TEXT,                 -- OTP expiry (datetime; nullable)
  otp_attempts INTEGER NOT NULL DEFAULT 0,  -- failed verify count for the active code; locks out at 5
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  end_time TEXT DEFAULT '',
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  color TEXT DEFAULT '#3498db',
  max_participants INTEGER DEFAULT 0,        -- 0 = unlimited (no cap). Capacity only; independent of price.
  price INTEGER NOT NULL DEFAULT 0,          -- price in AGOROT (5000 = ₪50); 0 = free (instant-confirm, no Bit hold)
  current_participants INTEGER NOT NULL DEFAULT 0,  -- authoritative held-seat counter (pending + confirmed)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  user_id INTEGER DEFAULT NULL,
  -- Booking state machine for the seat-hold / Bit-payment flow.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'waitlisted', 'expired')),
  -- Hold timestamp the sweeper uses to expire unpaid 'pending' rows after 15 min.
  -- (signed_at is kept for backward-compat; created_at is the booking clock.)
  created_at TEXT DEFAULT (datetime('now')),
  signed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);
-- Speeds up the sweeper scan for expirable holds.
CREATE INDEX IF NOT EXISTS idx_participants_status_created ON participants(status, created_at);
