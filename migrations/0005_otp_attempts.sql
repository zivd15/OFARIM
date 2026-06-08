-- Migration 0005: OTP brute-force attempt limiter
--   npx wrangler d1 execute ofarim --file=migrations/0005_otp_attempts.sql --remote
--
-- Counts failed /verify-otp tries against the current code. request-otp resets it
-- to 0; verify-otp increments it and locks out (burns the code) at 5.

ALTER TABLE users ADD COLUMN otp_attempts INTEGER NOT NULL DEFAULT 0;
