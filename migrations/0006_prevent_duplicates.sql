-- Migration 0006: DB-level duplicate registration prevention
-- Run ONCE:
--   npx wrangler d1 execute ofarim --file=migrations/0006_prevent_duplicates.sql --remote
--
-- Covers two surfaces:
--
-- 1. users.email — already UNIQUE in schema.sql. Nothing to change for fresh
--    databases. For legacy DBs that were created before the UNIQUE keyword was
--    added, we create a unique index as the equivalent enforcement. The
--    IF NOT EXISTS guard makes this idempotent on all environments.
--
-- 2. participants(event_id, user_id) — no DB-level guard exists today; only an
--    application pre-check. SQLite does not support ALTER TABLE ADD CONSTRAINT,
--    so we use a partial UNIQUE INDEX instead, which SQLite treats as equivalent
--    to a constraint.
--
--    Scope: user_id IS NOT NULL AND status != 'expired'
--      - Anonymous rows (user_id NULL) are excluded: NULL != NULL in SQL, so a
--        plain UNIQUE index would never fire for them anyway. They fall back to
--        the app-level name+phone pre-check.
--      - 'expired' rows are excluded: a user whose Bit hold lapsed should be
--        able to register again. The partial index ignores expired rows so the
--        new INSERT doesn't conflict with their old expired row.

-- ── 1. users.email ────────────────────────────────────────────────────────────
-- This is a no-op on fresh databases (the column is already UNIQUE).
-- On legacy databases without the constraint it creates the enforcement.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_email
  ON users(email);

-- ── 2. participants: one active registration per (user, event) ────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uniq_participants_user_event_active
  ON participants(event_id, user_id)
  WHERE user_id IS NOT NULL AND status != 'expired';
