# Migrations

Incremental SQL applied **in order** to an existing D1 database. For a brand-new
database, `schema.sql` already contains the final shape — run that instead (these
migrations are not needed for a fresh DB).

**Applied automatically on every push (as of 2026-07-31).** Both `deploy.yml` and
`deploy-staging.yml` run `npx wrangler d1 migrations apply` against the matching D1
database (`ofarim` / `ofarim-staging`) as a step *before* the Pages deploy, using
wrangler's built-in migration tracking (`d1_migrations` table — records which files
have already run, so nothing here is ever re-executed once applied). Add a new file
here and it lands on both environments automatically the next time each branch is
pushed — no manual `wrangler d1 execute` step required anymore.

To run one manually (local dev, or investigating something):
```bash
npx wrangler d1 migrations apply ofarim --remote            # prod
npx wrangler d1 migrations apply ofarim-staging --remote --env preview   # staging
```
(omit `--remote` for local). Avoid `wrangler d1 execute --file=...` for these files
going forward — it bypasses the tracking table and can double-apply a migration.

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

## ⚠️ Every schema change needs a migration file — no exceptions

The 0011 incident: a column was added to `ofarim-staging` by hand, noted only as a loose
comment in `schema.sql`, and never run against production. The code that depended on it
(`SELECT ... e.registration_closed ...`) shipped to `main` anyway, production's `events`
table didn't have the column, the query threw, and the calendar silently showed zero
events — no error visible to users, no crash, just an empty list.

**Rule going forward:** any DB schema change gets a numbered file in this folder *first*,
committed in the same PR as the code that depends on it — CI applies it to both databases
automatically on the next push to `staging` / `main`, so it can no longer land on one and
not the other. `schema.sql` is auto-generated (`npm run db:export:prod`) and should never
be hand-edited to "declare" a column that hasn't actually been applied.

## ⚠️ One-time / non-idempotent

- **`0003_price_to_agorot.sql`** multiplies `price` by 100. Running it twice would scale
  prices ×10000. Run it **once**. `wrangler d1 migrations apply` won't re-run it as long
  as it's already recorded in `d1_migrations` — this only bites if someone runs it by hand
  via `wrangler d1 execute --file=...` instead of the tracked `migrations apply` command.

## SQLite gotchas baked into these files

- `ALTER TABLE … ADD COLUMN` **cannot** use `DEFAULT CURRENT_TIMESTAMP`, so
  `participants.created_at` is added nullable in 0001 and backfilled, while the app sets
  it explicitly on insert. The fresh `schema.sql` uses `DEFAULT (datetime('now'))`.
- `ADD COLUMN … NOT NULL` requires a constant default (provided for `status`,
  `current_participants`, `otp_attempts`).
