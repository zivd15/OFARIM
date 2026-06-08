-- Migration 0004: Passwordless user auth (OTP)
--   npx wrangler d1 execute ofarim --file=migrations/0004_user_otp.sql --remote
--
-- Adds the OTP columns to users. The legacy `password` column is kept (SQLite
-- can't drop NOT NULL without a table rebuild); new OTP users store '' there,
-- which can never match verifyPassword (it requires a 'pbkdf2:' prefix).
-- Both OTP columns are nullable, so no backfill is needed for existing rows.

ALTER TABLE users ADD COLUMN otp_code TEXT;
ALTER TABLE users ADD COLUMN otp_expires_at TEXT;
