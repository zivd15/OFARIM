-- Migration 0009: Participant Notes
-- Run ONCE:
--   npx wrangler d1 execute ofarim --file=migrations/0009_participant_notes.sql --remote

ALTER TABLE participants ADD COLUMN notes TEXT;
