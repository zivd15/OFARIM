-- Ofarim canonical schema — AUTO-GENERATED from the live production DB:
--   npm run db:export:prod   (wrangler d1 export ofarim --remote --no-data)
-- This is the authoritative final shape (includes all migrations 0001-0012).
-- NOTE: `wrangler d1 export` does not preserve this header — re-add it after
-- regenerating, or the rules below are silently lost.
-- Do NOT hand-edit this file to "declare" a column — if it's not in the live
-- prod DB, it doesn't belong here. Add a migrations/NNNN_*.sql file instead,
-- apply it to prod, then regenerate this file.
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
, current_participants INTEGER NOT NULL DEFAULT 0, price INTEGER NOT NULL DEFAULT 0, allow_couples INTEGER NOT NULL DEFAULT 0, couple_price  INTEGER NOT NULL DEFAULT 0, payment_link TEXT, confirmation_message TEXT, reminder_message TEXT, registration_closed INTEGER NOT NULL DEFAULT 0);
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
  CHECK (spots IN (1, 2)), notes TEXT, reminder_sent INTEGER NOT NULL DEFAULT 0, bundle_registration_id INTEGER DEFAULT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE TABLE page_views (id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT NOT NULL, session_id TEXT NOT NULL, country TEXT, referrer TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  -- Discounted TOTAL for the whole series, in agorot (same unit as events.price).
  price INTEGER NOT NULL DEFAULT 0,
  color TEXT DEFAULT '#A09850',
  payment_link TEXT,
  confirmation_message TEXT,
  registration_closed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE bundle_events (
  bundle_id INTEGER NOT NULL,
  event_id  INTEGER NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bundle_id, event_id),
  FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id)  REFERENCES events(id)  ON DELETE CASCADE
);
CREATE TABLE bundle_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id INTEGER NOT NULL,
  user_id   INTEGER DEFAULT NULL,
  -- Client-generated idempotency handle. The per-event participant rows are inserted
  -- in the SAME batch as this row and look their parent up by this token, because a
  -- D1 batch cannot read a previous statement's RETURNING value.
  token TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  notes TEXT,
  -- Price actually charged for this purchase, in agorot (snapshot of bundles.price).
  price INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE
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
CREATE INDEX idx_pv_created_at ON page_views(created_at);
CREATE INDEX idx_pv_session ON page_views(session_id);
CREATE INDEX idx_bundle_events_bundle  ON bundle_events(bundle_id);
CREATE INDEX idx_bundle_events_event   ON bundle_events(event_id);
CREATE INDEX idx_bundle_regs_bundle    ON bundle_registrations(bundle_id);
CREATE INDEX idx_bundle_regs_user      ON bundle_registrations(user_id);
CREATE INDEX idx_participants_bundlereg ON participants(bundle_registration_id);
CREATE UNIQUE INDEX uniq_bundle_regs_user_active
  ON bundle_registrations(bundle_id, user_id)
  WHERE user_id IS NOT NULL AND status != 'expired';
CREATE TRIGGER trg_bundle_reg_no_overbook
BEFORE INSERT ON bundle_registrations
BEGIN
  SELECT RAISE(ABORT, 'BUNDLE_EVENT_FULL')
  WHERE EXISTS (
    SELECT 1
      FROM bundle_events be
      JOIN events e ON e.id = be.event_id
     WHERE be.bundle_id = NEW.bundle_id
       AND e.max_participants > 0
       AND e.current_participants > e.max_participants
  );
END;
