-- Migration 0001: Atomic Booking Engine & Seat Hold System
-- Run ONCE against an existing database that predates these columns:
--   npx wrangler d1 execute ofarim --file=migrations/0001_booking_engine.sql --remote
--
-- Safe to run on the live DB. NOT needed for a fresh `db:init` (schema.sql already
-- includes these columns). SQLite forbids DEFAULT CURRENT_TIMESTAMP in ADD COLUMN,
-- so created_at is added nullable and backfilled, then populated explicitly by the app.

-- 1. events.current_participants — atomic capacity counter
ALTER TABLE events ADD COLUMN current_participants INTEGER NOT NULL DEFAULT 0;

-- 2. participants.status — booking state machine
ALTER TABLE participants ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'confirmed', 'waitlisted', 'expired'));

-- 3. participants.created_at — hold clock (nullable: ADD COLUMN can't default to a timestamp)
ALTER TABLE participants ADD COLUMN created_at TEXT;

-- Backfill created_at from the legacy signed_at (or now if absent).
UPDATE participants SET created_at = COALESCE(signed_at, datetime('now')) WHERE created_at IS NULL;

-- Legacy participants were real, completed registrations — mark them confirmed,
-- not 'pending' (which the ADD COLUMN default set them to).
UPDATE participants SET status = 'confirmed';

-- Backfill the counter so it reflects already-held seats (pending + confirmed).
UPDATE events SET current_participants = (
  SELECT COUNT(*) FROM participants p
  WHERE p.event_id = events.id AND p.status IN ('pending', 'confirmed')
);

-- Index to speed up the sweeper scan.
CREATE INDEX IF NOT EXISTS idx_participants_status_created ON participants(status, created_at);
