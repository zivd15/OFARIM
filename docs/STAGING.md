# Staging / QA Environment

An isolated sandbox for testing OFARIM with **zero risk** to production data, customers, or email. Built on Cloudflare Pages' Preview environment.

## How it works

| Piece | Production | Staging |
|---|---|---|
| URL | `ofarim.pages.dev` (the `main` branch) | `staging.ofarim.pages.dev` (the `staging` branch) |
| Database (D1) | `ofarim` | `ofarim-staging` (separate — **no shared data**) |
| Env flag | `ENVIRONMENT` unset | `ENVIRONMENT=staging` |

Every QA behavior is gated in the API by `isStaging(c)` (`c.env.ENVIRONMENT === 'staging'`). Because production never sets that variable, **none of the staging behaviors can run in production.** Staging-only routes (`/api/staging/*`) return `404` in production.

> **The one rule:** never set `ENVIRONMENT` on the *production* Pages environment. That flag is the master switch for every test shortcut below.

## What changes in staging (and the gate for each)

| Behavior | Production | Staging |
|---|---|---|
| **Login OTP** | Emailed via Brevo | **No email** — code is logged and returned as `dev_otp` in the response (shown on the login screen) |
| **Turnstile** (anti-bot) | Enforced | Skipped |
| **OTP cooldown / 5-attempt lock** | Enforced | Skipped |
| **Seat-hold expiry** (`/internal/cleanup-holds`) | 15-minute window | **0 minutes** — releases unpaid holds instantly on demand |
| **Error responses** | Generic "Internal server error" | Full `message` + `stack` |
| **Admin entry** | Email-code login | `POST /api/staging/admin-login` returns an admin token instantly |
| **Mock data** | — | `POST /api/staging/seed` builds scenarios in one call |
| **Banner** | None | Red "STAGING" ribbon on every page (hostname-based) |

## Using staging (for testers)

**Log in as a user** — go to `staging.ofarim.pages.dev/login`, enter any email, complete the (auto-passing test) widget, press send. The 6-digit code appears **on screen** (also in `dev_otp`). No real email is sent.

**Log in as admin (fast-track)** — skip the UI entirely:
```bash
curl -s -X POST https://staging.ofarim.pages.dev/api/staging/admin-login \
  -H 'X-Staging-Token: <STAGING_ADMIN_TOKEN>'
# → { token, admin }  — use the token as: Authorization: Bearer <token>
```

**Generate a stress scenario** (a full event + waiting list):
```bash
curl -s -X POST https://staging.ofarim.pages.dev/api/staging/seed \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"full_with_waitlist","capacity":3,"waitlist":10}'
# → { event_id, confirmed:3, waitlisted:10 }
```

**Release unpaid seats instantly** (no 15-minute wait):
```bash
curl -s -X POST https://staging.ofarim.pages.dev/api/internal/cleanup-holds \
  -H 'Authorization: Bearer <CRON_SECRET>'
```

## Secrets matrix (Preview environment)

Set these on the Cloudflare dashboard → **ofarim** → Settings → Variables and Secrets → environment = **Preview**:

| Secret/var | Needed in staging? | Notes |
|---|---|---|
| `ENVIRONMENT` | **Yes** (`staging`) | The master switch. Comes from `wrangler.toml`; verify it's present on Preview. |
| `JWT_SECRET` | **Yes** | Use a value distinct from production. |
| `STAGING_ADMIN_TOKEN` | **Yes** | Long random string — guards the admin fast-entry endpoint. |
| `CRON_SECRET` | **Yes** | Guards `cleanup-holds`. |
| `INIT_ADMIN_PASSWORD` | Optional | Only if you bootstrap a real admin via `/setup-admin`. |
| `BREVO_API_KEY` | **No** | Staging never sends email. |
| `TURNSTILE_SECRET_KEY` | **No** | Staging skips Turnstile. |

The Preview **D1 binding** (`DB → ofarim-staging`) and `ENVIRONMENT` come from `wrangler.toml [env.preview]`. If a deploy shows they didn't apply, set them in the dashboard (D1 bindings → Preview; Variables → Preview).

## Deploy & promotion flow

1. Build a feature on a branch → push → Cloudflare auto-creates a preview deploy.
2. Merge/push to **`staging`** → QA on `staging.ofarim.pages.dev`.
3. Open a PR into **`main`** → review → merge → production deploy.

**`main` is protected** (GitHub → Settings → Branches): no direct pushes; changes land via PR only.

## Emergency rollback (< 60 seconds)

Cloudflare Pages keeps every past deployment.

1. Dashboard → **Workers & Pages → ofarim → Deployments**.
2. Find the last known-good **production** deployment.
3. **⋯ → Rollback to this deployment.** Production is restored instantly (no rebuild).

> Rollback reverts **code/assets only** — it does not undo D1 *data* changes. Back up data separately before risky migrations.

## Re-creating / refreshing the staging DB

The staging schema is a copy of production's shape (no data):
```bash
npm run db:export:prod      # refresh schema.sql from live prod (schema only)
npm run db:schema:staging   # apply it to ofarim-staging
```

## Not yet applicable (future hooks)

- **Media isolation** — the app has no file storage today. When uploads are added, bind a separate `ofarim-staging` R2 bucket under `wrangler.toml [env.preview]`, exactly like the D1 binding.
- **Analytics isolation** — there are no analytics/pixels today. When added, load them only on the production host (the same hostname check `public/staging-banner.js` uses).
