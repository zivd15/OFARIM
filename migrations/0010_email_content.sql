-- Migration 0010: Per-event email content for confirmation + reminder emails
-- Run ONCE:
--   npx wrangler d1 execute ofarim --file=migrations/0010_email_content.sql --remote

ALTER TABLE events ADD COLUMN confirmation_message TEXT;
ALTER TABLE events ADD COLUMN reminder_message TEXT;
ALTER TABLE participants ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0;
