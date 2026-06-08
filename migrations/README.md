# Migrations

Incremental SQL applied **in order** to an existing D1 database. For a brand-new
database, `schema.sql` already contains the final shape — run that instead (these
migrations are not needed for a fresh DB).

Apply each to the remote DB with:
```bash
npx wrangler d1 execute ofarim --file=migrations/<file>.sql --remote
```
(omit `--remote` for local).

## Order & purpose

| # | File | Adds | Notes |
|---|---|---|---|
| 0001 | `0001_booking_engine.sql` | `events.current_participants`; `participants.status`, `participants.created_at` + index | Backfills counters; marks legacy participants `confirmed`. |
| 0002 | `0002_event_price.sql` | `events.price` | Defaults existing events to `0` (free). |
| 0003 | `0003_price_to_agorot.sql` | — (data) | Rescales prices to **agorot** (`× 100`). **Run exactly once.** No-op if all prices are 0. |
| 0004 | `0004_user_otp.sql` | `users.otp_code`, `users.otp_expires_at` | Passwordless OTP columns (nullable). |
| 0005 | `0005_otp_attempts.sql` | `users.otp_attempts` | Brute-force attempt counter (default 0). |

## ⚠️ One-time / non-idempotent

- **`0003_price_to_agorot.sql`** multiplies `price` by 100. Running it twice would scale
  prices ×10000. Run it **once**.

## SQLite gotchas baked into these files

- `ALTER TABLE … ADD COLUMN` **cannot** use `DEFAULT CURRENT_TIMESTAMP`, so
  `participants.created_at` is added nullable in 0001 and backfilled, while the app sets
  it explicitly on insert. The fresh `schema.sql` uses `DEFAULT (datetime('now'))`.
- `ADD COLUMN … NOT NULL` requires a constant default (provided for `status`,
  `current_participants`, `otp_attempts`).
