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
| 0006 | `0006_prevent_duplicates.sql` | Partial unique index `uniq_participants_user_event_active` | `(event_id, user_id) WHERE user_id IS NOT NULL AND status != 'expired'` — blocks duplicate active registrations. |
| 0007 | `0007_couple_registration.sql` | `events.allow_couples`, `events.couple_price`; `participants.ticket_type`, `participants.spots` | Couple tickets hold 2 seats. |
| 0008 | `0008_event_payment_link.sql` | `events.payment_link` | Per-event Bit/PayBox URL. |
| 0009 | `0009_participant_notes.sql` | `participants.notes` | Optional free-text on registration. |
| 0010 | `0010_email_content.sql` | `events.confirmation_message`, `events.reminder_message`; `participants.reminder_sent` | Per-event confirmation & 24h reminder email text. |
| 0011 | `0011_registration_closed.sql` | `events.registration_closed` | FOMO toggle. Was previously applied only to `ofarim-staging`, undocumented — broke prod on 2026-07-31 when the code shipped without it. |
| 0012 | `0012_bundles.sql` | `bundles`, `bundle_events`, `bundle_registrations`; `participants.bundle_registration_id`; trigger `trg_bundle_reg_no_overbook` | Series sold as one discounted unit. The trigger is what makes a bundle registration all-or-nothing — see the comment in the file. |

## ⚠️ Every schema change needs a migration file — no exceptions

The 0011 incident: a column was added to `ofarim-staging` by hand, noted only as a loose
comment in `schema.sql`, and never run against production. The code that depended on it
(`SELECT ... e.registration_closed ...`) shipped to `main` anyway, production's `events`
table didn't have the column, the query threw, and the calendar silently showed zero
events — no error visible to users, no crash, just an empty list.

**Rule going forward:** any DB schema change gets a numbered file in this folder *first*,
committed in the same PR as the code that depends on it. Before merging `staging` → `main`,
run every new migration against **both** `ofarim-staging` and `ofarim` (prod) — staging-only
is not done. `schema.sql` is auto-generated (`npm run db:export:prod`) and should never be
hand-edited to "declare" a column that hasn't actually been applied.

## ⚠️ One-time / non-idempotent

- **`0003_price_to_agorot.sql`** multiplies `price` by 100. Running it twice would scale
  prices ×10000. Run it **once**.

## SQLite gotchas baked into these files

- `ALTER TABLE … ADD COLUMN` **cannot** use `DEFAULT CURRENT_TIMESTAMP`, so
  `participants.created_at` is added nullable in 0001 and backfilled, while the app sets
  it explicitly on insert. The fresh `schema.sql` uses `DEFAULT (datetime('now'))`.
- `ADD COLUMN … NOT NULL` requires a constant default (provided for `status`,
  `current_participants`, `otp_attempts`).
