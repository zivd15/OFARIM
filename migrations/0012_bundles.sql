-- Migration 0012: Bundles / Series ("סדרה")
-- Run ONCE per database:
--   npx wrangler d1 execute ofarim-staging --file=migrations/0012_bundles.sql --remote
--   npx wrangler d1 execute ofarim         --file=migrations/0012_bundles.sql --remote
--
-- Groups several existing events into one purchasable "series" sold at a single
-- discounted total price. Registering for a bundle holds a seat in EVERY event of
-- the bundle, all-or-nothing — see the trigger at the bottom of this file.
--
-- Tables
--   bundles               — the series itself (title, discounted total price in AGOROT).
--   bundle_events         — which events belong to which bundle (+ display order).
--   bundle_registrations  — one row per purchase of a series; the N per-event
--                           `participants` rows point back at it.
--
-- `participants.bundle_registration_id` is NULL for ordinary single-event
-- registrations, so every existing row and code path is unaffected.

CREATE TABLE IF NOT EXISTS bundles (
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

CREATE TABLE IF NOT EXISTS bundle_events (
  bundle_id INTEGER NOT NULL,
  event_id  INTEGER NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bundle_id, event_id),
  FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id)  REFERENCES events(id)  ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bundle_registrations (
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

-- Links an ordinary participant row to the series purchase that created it.
-- NULL for every pre-existing row and for all single-event registrations.
ALTER TABLE participants ADD COLUMN bundle_registration_id INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_bundle_events_bundle  ON bundle_events(bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundle_events_event   ON bundle_events(event_id);
CREATE INDEX IF NOT EXISTS idx_bundle_regs_bundle    ON bundle_registrations(bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundle_regs_user      ON bundle_registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_participants_bundlereg ON participants(bundle_registration_id);

-- One active purchase of a given series per logged-in user (mirrors
-- uniq_participants_user_event_active). An 'expired' hold does not block a retry.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bundle_regs_user_active
  ON bundle_registrations(bundle_id, user_id)
  WHERE user_id IS NOT NULL AND status != 'expired';

-- ── The all-or-nothing guard ─────────────────────────────────────────────────
-- Bundle registration runs as ONE D1 batch (= one SQLite transaction):
--   1. bump current_participants on EVERY event of the bundle, unconditionally
--   2. INSERT the bundle_registrations row  ← this trigger fires here
--   3. INSERT the N participants rows
-- If step 1 pushed any capped event past its cap, this RAISE(ABORT) fails
-- statement 2, which rolls the whole batch back — the increments included. So a
-- bundle can never be partially reserved, and it can never overbook an event.
-- Doing the check here (rather than as a conditional UPDATE in step 1) is what
-- makes it atomic: the check reads the state the increments just wrote, inside
-- the same transaction, with no window for a concurrent registration to slip in.
CREATE TRIGGER IF NOT EXISTS trg_bundle_reg_no_overbook
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
