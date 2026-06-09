-- Migration 0007: Couple Registration
-- Run ONCE:
--   npx wrangler d1 execute ofarim --file=migrations/0007_couple_registration.sql --remote
--
-- Events gain two new flags:
--   allow_couples  — 0/1 boolean; when 1 the registration form shows a "Couple" option.
--   couple_price   — price in AGOROT for a couple ticket (same unit as `price`).
--
-- Participants gain two new columns:
--   ticket_type — 'single' | 'couple' (DEFAULT 'single' covers all legacy rows).
--   spots       — seats consumed: 1 for single, 2 for couple (DEFAULT 1 covers legacy rows).
--
-- The `current_participants` counter already tracks held seats; couple registrations
-- will increment it by 2 atomically at registration time, so no backfill is needed.

ALTER TABLE events ADD COLUMN allow_couples INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN couple_price  INTEGER NOT NULL DEFAULT 0;

ALTER TABLE participants ADD COLUMN ticket_type TEXT NOT NULL DEFAULT 'single'
  CHECK (ticket_type IN ('single', 'couple'));
ALTER TABLE participants ADD COLUMN spots INTEGER NOT NULL DEFAULT 1
  CHECK (spots IN (1, 2));
