-- Migration 0011: registration_closed flag for FOMO
--   npx wrangler d1 execute ofarim --file=migrations/0011_registration_closed.sql --remote
--
-- Lets an admin manually close registration on an event while spots remain
-- (FOMO toggle in admin.html). Was previously only run ad-hoc against
-- ofarim-staging and documented as a loose comment in schema.sql instead of
-- a tracked migration — production never got it, which broke /events/public
-- (SELECT referenced a column that didn't exist) until this was applied
-- directly on 2026-07-31. This file exists so a fresh DB / any other
-- environment can no longer miss it.

ALTER TABLE events ADD COLUMN registration_closed INTEGER NOT NULL DEFAULT 0;
