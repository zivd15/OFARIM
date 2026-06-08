-- Migration 0002: Event pricing / free-event logic
-- Run ONCE against an existing database:
--   npx wrangler d1 execute ofarim --file=migrations/0002_event_price.sql --remote
--
-- price is independent of capacity (max_participants). 0 = free → registration
-- instant-confirms with no 15-minute Bit hold. Existing events default to 0
-- (free), which preserves the pre-payment behaviour for legacy events.

ALTER TABLE events ADD COLUMN price INTEGER NOT NULL DEFAULT 0;
