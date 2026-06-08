# Deployment

## Overview

Pushing to `main` triggers `.github/workflows/deploy.yml`, which runs
`wrangler pages deploy public --project-name=ofarim`. You can also deploy manually with
`npm run deploy`.

## 1. Environment variables & secrets

All server secrets are set as **Pages secrets** (production) or in a local **`.dev.vars`**
file (local dev). The app fails closed on the relevant route if a secret it needs is
missing.

| Secret | Used by | Notes |
|---|---|---|
| `JWT_SECRET` | All authenticated routes | **Required.** No fallback — app 500s without it. |
| `INIT_ADMIN_PASSWORD` | `POST /setup-admin` | Gates first-admin creation. |
| `CRON_SECRET` | `POST /internal/cleanup-holds` | Bearer token for the sweeper cron. |
| `WEBHOOK_SECRET` | `POST /events/:id/confirm-payment` | `X-Webhook-Secret` for payment webhooks. |
| `TURNSTILE_SECRET_KEY` | `POST /user-auth/request-otp` | Cloudflare Turnstile. Dev test key: `1x0000000000000000000000000000000AA`. |
| `BREVO_API_KEY` | `POST /user-auth/request-otp` | Brevo HTTP API key (email delivery). |

GitHub Actions also needs repo secrets `CLOUDFLARE_API_TOKEN` (and the account id, which
is inlined in the workflow).

### Set production secrets
```bash
npx wrangler pages secret put JWT_SECRET
npx wrangler pages secret put INIT_ADMIN_PASSWORD
npx wrangler pages secret put CRON_SECRET
npx wrangler pages secret put WEBHOOK_SECRET
npx wrangler pages secret put TURNSTILE_SECRET_KEY
npx wrangler pages secret put BREVO_API_KEY
```

### Local `.dev.vars` (do NOT commit)
```ini
JWT_SECRET="dev-only-change-me"
INIT_ADMIN_PASSWORD="dev-init"
CRON_SECRET="dev-cron"
WEBHOOK_SECRET="dev-webhook"
TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"   # always-passes test key
BREVO_API_KEY="xkeysib-..."
```

> The Turnstile **site key** in `public/login.html` is the always-passes dev key
> `1x00000000000000000000AA`. Replace it (and the secret) with your real keypair for prod.

## 2. Database

### Fresh database
```bash
npm run db:create            # once, creates the "ofarim" D1 db
npm run db:init:remote       # applies schema.sql to the remote db
```

### Existing database — run migrations in order
See [../migrations/README.md](../migrations/README.md). In short:
```bash
npx wrangler d1 execute ofarim --file=migrations/0001_booking_engine.sql  --remote
npx wrangler d1 execute ofarim --file=migrations/0002_event_price.sql     --remote
npx wrangler d1 execute ofarim --file=migrations/0003_price_to_agorot.sql --remote
npx wrangler d1 execute ofarim --file=migrations/0004_user_otp.sql        --remote
npx wrangler d1 execute ofarim --file=migrations/0005_otp_attempts.sql    --remote
```

## 3. Brevo (email)

1. Create a Brevo account and an API key (`xkeysib-…`) → set as `BREVO_API_KEY`.
2. **Verify a sender domain** (SPF/DKIM) in Brevo, then update the sender address in
   `functions/api/[[path]].js` (`request-otp` → `emailPayload.sender.email`,
   currently `noreply@your-domain.com`).

## 4. Turnstile (anti-bot)

1. Create a Turnstile widget in the Cloudflare dashboard → get a site key + secret key.
2. Set `TURNSTILE_SECRET_KEY` (secret) and replace the site key in `public/login.html`.

## 5. Cron Trigger (seat-hold sweeper)

Schedule a recurring POST to `/api/internal/cleanup-holds` with
`Authorization: Bearer <CRON_SECRET>` (e.g. every 5 minutes) so unpaid holds expire and
seats are released.

## 6. First admin

```bash
curl -X POST https://<your-app>.pages.dev/api/setup-admin \
  -H 'Content-Type: application/json' \
  -d '{"secret":"<INIT_ADMIN_PASSWORD>","email":"you@example.com","password":"<min 8 chars>"}'
```
If an old default admin row exists from a previous build, delete it first — `/setup-admin`
refuses to run once any admin exists.

## 7. Pre-launch sanity check (before enabling public registration)

Run this once, end-to-end, against the live deployment:

```bash
APP="https://<your-app>.pages.dev"

# 1. /setup-admin should now REFUSE (admin already exists) — proves bootstrap is locked.
curl -s -o /dev/null -w "setup-admin (expect 403): %{http_code}\n" \
  -X POST "$APP/api/setup-admin" \
  -H 'Content-Type: application/json' \
  -d '{"secret":"<INIT_ADMIN_PASSWORD>","email":"x@x.com","password":"abcd1234"}'

# 2. Admin login should SUCCEED and return a token.
curl -s -X POST "$APP/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"<your-admin-password>"}' \
  | grep -q '"token"' && echo "admin login: OK" || echo "admin login: FAILED"

# 3. Public events endpoint should return JSON (a 200 array).
curl -s -o /dev/null -w "events/public (expect 200): %{http_code}\n" "$APP/api/events/public"

# 4. A bad route should return JSON {"error":...}, not HTML (proves the JSON error handler).
curl -s "$APP/api/does-not-exist" -w "\n"
```

Expected: `403`, `admin login: OK`, `200`, and `{"error":"Not found"}`. If `/setup-admin`
returns `201` instead of `403`, **no admin exists yet** — create one before launch.

## Verifying / debugging

- Tail logs (incl. the OTP `console.error` on Brevo failures):
  ```bash
  npx wrangler pages deployment tail
  ```
- Query the D1 database directly:
  ```bash
  npx wrangler d1 execute ofarim --command "SELECT id,title,price,current_participants FROM events" --remote
  ```
