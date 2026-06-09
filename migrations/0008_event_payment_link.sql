-- Migration 0008: Event Payment Link
-- Run ONCE:
--   npx wrangler d1 execute ofarim --file=migrations/0008_event_payment_link.sql --remote
--
-- Adds an optional per-event payment link (PayBox / Bit / any URL).
-- NULL means no link configured; empty string is treated the same in the frontend.

ALTER TABLE events ADD COLUMN payment_link TEXT;
