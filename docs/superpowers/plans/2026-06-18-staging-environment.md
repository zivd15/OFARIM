# Staging / QA Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a fully isolated staging/QA environment for OFARIM where testers can exercise edge cases (double-booking, overcapacity, instant cart-expiry, admin flows) with zero risk to production data, customers, or email.

**Architecture:** Cloudflare Pages' built-in **Preview** environment (the `staging` branch → `staging.ofarim.pages.dev`) bound to a **separate** D1 database (`ofarim-staging`). A single variable `ENVIRONMENT="staging"`, set **only** on the Preview environment, gates every QA behavior via `isStaging(c)`. Production never sets the var, so all bypasses are inert there. Staging-only endpoints live under `/staging/*` and return 404 in production.

**Tech Stack:** Cloudflare Pages + Pages Functions, Hono v4, D1 (SQLite), wrangler 3.x. No test framework exists in this repo — verification is done with `curl` against `wrangler pages dev` (local) and against the deployed preview URL.

---

## Safety principle (read first)

Every staging behavior in this plan is gated on `isStaging(c)` (`c.env.ENVIRONMENT === 'staging'`). The production Pages environment must **never** have `ENVIRONMENT` set. Defense in depth:

1. **Flag gate** — `isStaging(c)` is false in prod → every bypass is dead code.
2. **404 in prod** — `/staging/*` routes don't exist unless staging.
3. **Separate secret** — the admin backdoor additionally requires `STAGING_ADMIN_TOKEN`, so a misconfigured flag alone can't open it.

When implementing, never weaken `authMiddleware`, `adminMiddleware`, `verifyTurnstile`, or the CORS allowlist with staging logic. Staging behavior is added *around* those, never *inside* the shared auth primitives — except the explicitly-listed bypasses in `request-otp` / `verify-otp`, which are themselves flag-gated.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `functions/api/[[path]].js` | The whole Hono API | Add `isStaging()` helper; extend `app.onError`; flag-gate `request-otp` (Brevo/cooldown/Turnstile), `verify-otp` (attempt lock), `cleanup-holds` (age threshold); add `/staging/*` guard + `admin-login` + `seed` |
| `wrangler.toml` | Bindings/vars config | Add `[env.preview]` with staging D1 binding + `ENVIRONMENT="staging"` var |
| `.dev.vars` (gitignored) | Local dev secrets/vars | Add `ENVIRONMENT="staging"` for local QA testing |
| `public/login.html` | OTP login UI | Hostname-gated: surface `dev_otp` from the response on staging |
| `public/staging-banner.js` (new) | Visible STAGING ribbon | Hostname-gated banner injected on every page |
| `package.json` | npm scripts | Add `db:create:staging`, `db:schema:staging` |
| `docs/STAGING.md` (new) | Runbook | Rollback protocol, branch protection, secrets, how testers use staging |
| `schema.sql` | Canonical DDL | Regenerate from the live prod export (it is currently stale) |

---

## Task 1: Foundation — `isStaging()` helper + stack-trace transparency

Proves the env-flag plumbing end-to-end with the simplest observable behavior (PRD: *full error transparency*).

**Files:**
- Modify: `functions/api/[[path]].js` (helper near top; `app.onError` at ~line 33)
- Create: `.dev.vars` (gitignored — add `ENVIRONMENT="staging"`)

- [ ] **Step 1: Add the `isStaging` helper** immediately after the Hono app is created (top of file, before `app.use('*', cors(...))`):

```js
// Staging/QA gate. TRUE only when the Preview environment sets ENVIRONMENT="staging".
// Production never sets this var, so every staging behavior below is inert in prod.
const isStaging = (c) => c?.env?.ENVIRONMENT === 'staging'
```

- [ ] **Step 2: Extend the error handler** for full stack traces in staging. Replace the existing handler (~line 33):

```js
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()   // preserves our JSON 500s (e.g. missing JWT_SECRET)
  console.error('Unhandled error:', err?.stack || err?.message || err)
  if (isStaging(c)) {
    return c.json({ error: 'Internal server error', message: err?.message, stack: err?.stack }, 500)
  }
  return c.json({ error: 'Internal server error' }, 500)   // prod: generic, no leakage
})
```

- [ ] **Step 3: Add `ENVIRONMENT` to local dev vars.** Create/append `.dev.vars` (it is gitignored; confirm with `git check-ignore .dev.vars`):

```
ENVIRONMENT="staging"
JWT_SECRET="local-dev-secret-change-me"
```

- [ ] **Step 4: Verify locally.** Start the dev server and hit a route that throws. Run:

```bash
npm run dev   # wrangler pages dev → http://localhost:8788
# In another shell — malformed JSON body forces a parse path; use a route that reads the DB with a bad binding to force a 500,
# or temporarily add `throw new Error('boom')` to a route. Simplest: confirm the flag is read:
curl -s http://localhost:8788/api/events/public?month=6&year=2026 -o /dev/null -w "%{http_code}\n"
```
Expected: `200` (sanity the server is up). Then temporarily add `throw new Error('boom')` at the top of the `/events/public` handler, re-run, and:
```bash
curl -s "http://localhost:8788/api/events/public?month=6&year=2026"
```
Expected (staging): JSON containing `"message":"boom"` and a `"stack"`. Remove the temporary throw.

- [ ] **Step 5: Commit**

```bash
git add "functions/api/[[path]].js"
git commit -m "feat(staging): isStaging() flag + stack traces in staging error handler"
```

---

## Task 2: Create the isolated `ofarim-staging` D1 (matching prod shape)

`schema.sql` is **stale** (missing migrations 0006–0010 columns + the partial unique index), so staging is built from an **export of the live prod schema** to guarantee parity.

**Files:**
- Modify: `wrangler.toml`
- Modify: `schema.sql` (regenerate from export — fixes the staleness)

- [ ] **Step 1: Create the staging database**

```bash
npx wrangler d1 create ofarim-staging
```
Expected: prints a `database_id` (a UUID). Copy it.

- [ ] **Step 2: Export the live production schema (no data)**

```bash
npx wrangler d1 export ofarim --remote --no-data --output=schema.sql
```
Expected: `schema.sql` now contains every table/index/column including `ticket_type`, `spots`, `notes`, `reminder_sent`, `allow_couples`, `couple_price`, `payment_link`, `confirmation_message`, `reminder_message`, and `uniq_participants_user_event_active`. (This also fixes the stale canonical schema.)

- [ ] **Step 3: Apply the schema to staging**

```bash
npx wrangler d1 execute ofarim-staging --remote --file=schema.sql
```
Expected: executes without error.

- [ ] **Step 4: Verify staging is empty and correctly shaped**

```bash
npx wrangler d1 execute ofarim-staging --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
npx wrangler d1 execute ofarim-staging --remote --command "SELECT COUNT(*) AS users FROM users"
```
Expected: tables `admins/users/events/participants` present; `users = 0`.

- [ ] **Step 5: Bind staging D1 + `ENVIRONMENT` to the Preview environment only.** Append to `wrangler.toml` (replace `<STAGING_DB_ID>` with the id from Step 1). Top-level (production) config is left untouched:

```toml
# ── Preview (staging) environment overrides ───────────────────────────────────
# Applies ONLY to non-production (preview) branch deploys, e.g. the `staging` branch.
# Production keeps the top-level DB binding and has NO ENVIRONMENT var.
[env.preview.vars]
ENVIRONMENT = "staging"

[[env.preview.d1_databases]]
binding = "DB"
database_name = "ofarim-staging"
database_id = "<STAGING_DB_ID>"
```

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml schema.sql
git commit -m "feat(staging): ofarim-staging D1 + preview env binding; regenerate canonical schema"
```

> NOTE: Pages wrangler-env binding support can be finicky. Task 11 includes a deploy-time verification (a debug echo) and a dashboard fallback for setting the Preview D1 binding + `ENVIRONMENT` var if the toml form doesn't take effect.

---

## Task 3: OTP — no outbound email in staging (return the code) + skip cooldown

PRD: *block outbound messaging*; *disable rate limits*. In staging, `request-otp` must not call Brevo and must hand the tester the code directly.

**Files:**
- Modify: `functions/api/[[path]].js` — `POST /user-auth/request-otp` (~lines 332–402)

- [ ] **Step 1: Skip the 60-second cooldown in staging.** Wrap the existing cooldown check:

```js
// 60-second cooldown (skipped in staging so testers can hammer the flow).
if (!isStaging(c)) {
  const recent = await c.env.DB.prepare(
    `SELECT 1 AS x FROM users
      WHERE email = ? AND otp_code IS NOT NULL AND otp_expires_at > datetime('now', '+9 minutes')`
  ).bind(normEmail).first()
  if (recent) return c.json({ error: 'נא להמתין 60 שניות לפני בקשת קוד חדש.' }, 429)
}
```

- [ ] **Step 2: Skip Brevo in staging; send it in prod.** Replace the `brevoKey` block + the Brevo `fetch` + `if (!response.ok)` block with:

```js
const code = generateOTP()

if (isStaging(c)) {
  // Staging: never touch Brevo. Log the code so it's visible in `wrangler ... tail`.
  console.log(`[staging-otp] ${normEmail} -> ${code}`)
} else {
  const brevoKey = c.env.BREVO_API_KEY
  if (!brevoKey) return c.json({ error: 'Email service is not configured' }, 500)
  const emailPayload = {
    sender: { name: 'OFARIM', email: 'ofarim.grow@gmail.com' },
    to: [{ email: normEmail }],
    subject: 'קוד הכניסה שלך למערכת עופרים',
    htmlContent: `<div dir="rtl" style="font-family: Arial, sans-serif; text-align: right;">
                    <h2>שלום${name ? ' ' + name : ''},</h2>
                    <p>קוד הכניסה שלך למערכת עופרים הוא:</p>
                    <h1 style="letter-spacing: 5px; background: #f4f4f5; padding: 10px; display: inline-block; border-radius: 5px;">${code}</h1>
                    <p>הקוד בתוקף ל-10 דקות.</p>
                    <p>אם לא ביקשת קוד זה, אנא התעלם מהודעה זו.</p>
                  </div>`,
  }
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'api-key': brevoKey, 'content-type': 'application/json' },
    body: JSON.stringify(emailPayload),
  })
  if (!response.ok) {
    console.error('[Brevo] send failed', response.status, await response.text().catch(() => ''))
    return c.json({ error: 'Failed to send verification email' }, 500)
  }
}
```

- [ ] **Step 3: Return the code in staging.** Change the final neutral `return c.json({ message: ... })` to include `dev_otp` in staging only:

```js
return c.json({ message: 'אם הכתובת קיימת, נשלח קוד.', ...(isStaging(c) ? { dev_otp: code } : {}) })
```

- [ ] **Step 4: Verify locally** (`.dev.vars` has `ENVIRONMENT="staging"`):

```bash
curl -s -X POST http://localhost:8788/api/user-auth/request-otp \
  -H 'Content-Type: application/json' -d '{"email":"qa1@test.local","name":"QA"}'
```
Expected: `200` with `"dev_otp":"NNNNNN"` in the body, and `[staging-otp] qa1@test.local -> NNNNNN` printed in the dev-server log. No Brevo call.

- [ ] **Step 5: Commit**

```bash
git add "functions/api/[[path]].js"
git commit -m "feat(staging): OTP returns code in-response and skips Brevo + cooldown"
```

---

## Task 4: Disable Turnstile + the 5-attempt lock in staging

PRD: *disable bot protections / rate limits*.

**Files:**
- Modify: `functions/api/[[path]].js` — `request-otp` (~line 340) and `verify-otp` (~line 418)

- [ ] **Step 1: Bypass Turnstile in staging.** Replace the Turnstile gate in `request-otp`:

```js
// Anti-bot gate (skipped in staging so testers don't need a widget token).
if (!isStaging(c)) {
  const secret = c.env.TURNSTILE_SECRET_KEY
  if (!secret) return c.json({ error: 'Turnstile is not configured' }, 500)
  const human = await verifyTurnstile(turnstileToken, secret, c.req.header('cf-connecting-ip'))
  if (!human) return c.json({ error: 'Bot verification failed' }, 403)
}
```

- [ ] **Step 2: Disable the attempt lock in staging.** In `verify-otp`, change the limit calc (~line 418):

```js
const withinLimit = isStaging(c) ? true : (row.otp_attempts <= MAX_OTP_ATTEMPTS)
```

- [ ] **Step 3: Verify locally** — request a code, then verify it without any Turnstile token:

```bash
OTP=$(curl -s -X POST http://localhost:8788/api/user-auth/request-otp \
  -H 'Content-Type: application/json' -d '{"email":"qa2@test.local"}' | grep -o '"dev_otp":"[0-9]*"' | grep -o '[0-9]*')
curl -s -X POST http://localhost:8788/api/user-auth/verify-otp \
  -H 'Content-Type: application/json' -d "{\"email\":\"qa2@test.local\",\"code\":\"$OTP\"}"
```
Expected: `200` with `{ user, token }` — no Turnstile token was supplied, proving the bypass.

- [ ] **Step 4: Commit**

```bash
git add "functions/api/[[path]].js"
git commit -m "feat(staging): bypass Turnstile and the 5-attempt OTP lock"
```

---

## Task 5: On-demand instant cart-expiry

PRD: *trigger time-based mechanisms instantly*. In staging, the sweeper expires **all** pending holds regardless of age.

**Files:**
- Modify: `functions/api/[[path]].js` — `POST /internal/cleanup-holds` (~lines 234–249)

- [ ] **Step 1: Make the age threshold staging-aware.** Replace the sweep UPDATE's hardcoded `-15 minutes` with a bound interval:

```js
// Staging expires holds immediately (0 min) so cart-release is testable on demand.
const ageMinutes = isStaging(c) ? 0 : 15
const { results: expired } = await c.env.DB.prepare(
  `UPDATE participants
      SET status = 'expired'
    WHERE status = 'pending'
      AND created_at < datetime('now', ?)
    RETURNING event_id, spots`
).bind(`-${ageMinutes} minutes`).all()
```
(Leave the rest of the handler — the spot-summing release + reconcile — unchanged.)

- [ ] **Step 2: Verify locally.** Register for a paid event to create a pending hold, then sweep immediately:

```bash
# (Assumes a paid event with id 1 exists in local staging DB — or create one via /staging/seed in Task 7.)
curl -s -X POST http://localhost:8788/api/events/1/register \
  -H 'Content-Type: application/json' -d '{"name":"QA","email":"qa3@test.local"}'
curl -s -X POST http://localhost:8788/api/internal/cleanup-holds \
  -H "Authorization: Bearer $CRON_SECRET_LOCAL"
```
Expected: the second call returns `{ "expired": 1, ... }` even though the hold is seconds old.

- [ ] **Step 3: Commit**

```bash
git add "functions/api/[[path]].js"
git commit -m "feat(staging): cleanup-holds expires pending holds instantly in staging"
```

---

## Task 6: Staging-only routes guard + admin fast-entry

PRD: *pre-approved admin backdoor*. A staging-only endpoint mints a real admin JWT; the live auth path is untouched.

**Files:**
- Modify: `functions/api/[[path]].js` — add a `/staging/*` guard + `POST /staging/admin-login` (place near the other route definitions, after the internal routes)

- [ ] **Step 1: Add the guard** so every `/staging/*` route 404s in production:

```js
// Staging-only namespace: 404 in production so these endpoints don't exist there.
app.use('/staging/*', async (c, next) => {
  if (!isStaging(c)) return c.json({ error: 'Not found' }, 404)
  await next()
})
```

- [ ] **Step 2: Add the admin fast-entry endpoint.** Requires the `STAGING_ADMIN_TOKEN` secret (constant-time), upserts a dummy admin into the staging DB, and returns a normal admin JWT:

```js
// Staging admin backdoor. Requires both ENVIRONMENT=staging (the /staging guard) AND
// a matching STAGING_ADMIN_TOKEN. Mints a real admin JWT for a dummy admin so the rest
// of the app's admin auth is exercised unchanged. The dummy admin's password is unusable
// ('pbkdf2:disabled' never matches verifyPassword), so it can only be entered this way.
app.post('/staging/admin-login', async c => {
  const provided = c.req.header('x-staging-token')
  if (!c.env.STAGING_ADMIN_TOKEN || !constantTimeEqual(provided, c.env.STAGING_ADMIN_TOKEN)) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const email = 'qa-admin@staging.local'
  let admin = await c.env.DB.prepare('SELECT id, name, email FROM admins WHERE email = ?').bind(email).first()
  if (!admin) {
    admin = await c.env.DB.prepare(
      "INSERT INTO admins (name, email, password) VALUES ('QA Admin', ?, 'pbkdf2:disabled') RETURNING id, name, email"
    ).bind(email).first()
  }
  const token = await generateToken({ id: admin.id, email: admin.email, name: admin.name }, 'admin', jwtSecret(c.env))
  return c.json({ token, admin })
})
```

- [ ] **Step 3: Add `STAGING_ADMIN_TOKEN` to `.dev.vars`** for local testing:

```
STAGING_ADMIN_TOKEN="local-staging-master-token"
```

- [ ] **Step 4: Verify locally** — token works, missing/wrong token is 403:

```bash
curl -s -X POST http://localhost:8788/api/staging/admin-login \
  -H 'X-Staging-Token: local-staging-master-token'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8788/api/staging/admin-login \
  -H 'X-Staging-Token: wrong'
```
Expected: first returns `{ token, admin }`; second returns `403`. (And in a non-staging run, the route returns `404`.)

- [ ] **Step 5: Commit**

```bash
git add "functions/api/[[path]].js"
git commit -m "feat(staging): /staging guard (404 in prod) + admin fast-entry endpoint"
```

---

## Task 7: Mock-data scenario generator

PRD: *one-click stress scenarios*. A staging-only endpoint builds named scenarios.

**Files:**
- Modify: `functions/api/[[path]].js` — add `POST /staging/seed`

- [ ] **Step 1: Add the seed endpoint.** Supports a `full_with_waitlist` scenario (a small-capacity event filled to capacity with `confirmed`, plus N `waitlisted`):

```js
// Staging scenario generator. Body: { scenario, waitlist?, capacity? }.
app.post('/staging/seed', async c => {
  const body = await c.req.json().catch(() => ({}))
  const scenario = body.scenario || 'full_with_waitlist'
  if (scenario !== 'full_with_waitlist') return c.json({ error: 'Unknown scenario' }, 400)

  const capacity = Number.isInteger(body.capacity) ? body.capacity : 3
  const waitlist = Number.isInteger(body.waitlist) ? body.waitlist : 10
  const date = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)   // +7 days

  const ev = await c.env.DB.prepare(
    `INSERT INTO events (title, date, time, location, max_participants, price, current_participants)
     VALUES ('QA: Full + Waitlist', ?, '10:00', 'QA Hall', ?, 0, ?)
     RETURNING id`
  ).bind(date, capacity, capacity).first()

  const stmts = []
  for (let i = 0; i < capacity; i++) {
    stmts.push(c.env.DB.prepare(
      "INSERT INTO participants (event_id, name, email, status, ticket_type, spots, created_at) VALUES (?, ?, ?, 'confirmed', 'single', 1, datetime('now'))"
    ).bind(ev.id, `Confirmed ${i + 1}`, `seed-c${i + 1}@test.local`))
  }
  for (let i = 0; i < waitlist; i++) {
    stmts.push(c.env.DB.prepare(
      "INSERT INTO participants (event_id, name, email, status, ticket_type, spots, created_at) VALUES (?, ?, ?, 'waitlisted', 'single', 1, datetime('now'))"
    ).bind(ev.id, `Waitlisted ${i + 1}`, `seed-w${i + 1}@test.local`))
  }
  await c.env.DB.batch(stmts)

  return c.json({ scenario, event_id: ev.id, capacity, confirmed: capacity, waitlisted: waitlist })
})
```

- [ ] **Step 2: Verify locally**

```bash
curl -s -X POST http://localhost:8788/api/staging/seed \
  -H 'Content-Type: application/json' -d '{"scenario":"full_with_waitlist","capacity":3,"waitlist":10}'
```
Expected: `{ event_id, capacity:3, confirmed:3, waitlisted:10 }`. A follow-up register on that event should return `{ status: "waitlisted" }` (it's full).

- [ ] **Step 3: Commit**

```bash
git add "functions/api/[[path]].js"
git commit -m "feat(staging): /staging/seed scenario generator (full event + waitlist)"
```

---

## Task 8: Frontend — STAGING banner + surface the dev OTP

So testers visually know they're in staging and can read the OTP without dev tools. Hostname-gated (no env needed client-side).

**Files:**
- Create: `public/staging-banner.js`
- Modify: `public/login.html` (surface `dev_otp`; include the banner script)
- Modify: `public/index.html`, `public/calendar.html`, `public/dashboard.html`, `public/admin.html` (include the banner script)

- [ ] **Step 1: Create `public/staging-banner.js`** — shows a ribbon on any non-production host:

```js
// Visible STAGING ribbon on any host that isn't the production domain.
(function () {
  var host = location.hostname;
  var isProd = host === 'ofarim.pages.dev' || host === 'www.ofarim.pages.dev';
  if (isProd) return;
  var bar = document.createElement('div');
  bar.textContent = '⚠ STAGING — נתוני בדיקה בלבד';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;' +
    'font:600 13px system-ui,sans-serif;text-align:center;padding:4px;letter-spacing:.04em;';
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(bar); });
})();
```

- [ ] **Step 2: Surface `dev_otp` in `login.html`.** In `handleRequestOtp` (after parsing the response `data`), before/after showing the OTP form, add:

```js
if (data && data.dev_otp) {
  // Staging only: the API handed us the code directly. Prefill + show it.
  var codeInput = document.querySelector('#otpForm [name="code"]');
  if (codeInput) codeInput.value = data.dev_otp;
  showError('STAGING — קוד: ' + data.dev_otp);   // reuse the visible message area
}
```

- [ ] **Step 3: Include the banner script** on each page — add before `</body>`:

```html
<script src="/staging-banner.js"></script>
```
Add to: `public/index.html`, `public/login.html`, `public/calendar.html`, `public/dashboard.html`, `public/admin.html`.

- [ ] **Step 4: Verify locally** — `wrangler pages dev` serves on `localhost` (non-prod host), so the banner shows and `login.html` displays the code after requesting it. Confirm the banner is **absent** when served from `ofarim.pages.dev` (visual check after deploy).

- [ ] **Step 5: Commit**

```bash
git add public/staging-banner.js public/index.html public/login.html public/calendar.html public/dashboard.html public/admin.html
git commit -m "feat(staging): STAGING banner + surface dev OTP on the login page"
```

---

## Task 9: npm scripts for the staging DB

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts** under `"scripts"`:

```json
"db:create:staging": "wrangler d1 create ofarim-staging",
"db:schema:staging": "wrangler d1 execute ofarim-staging --remote --file=schema.sql",
"db:export:prod": "wrangler d1 export ofarim --remote --no-data --output=schema.sql"
```

- [ ] **Step 2: Verify** the JSON parses:

```bash
node -e "require('./package.json'); console.log('package.json OK')"
```
Expected: `package.json OK`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(staging): npm scripts for staging DB create/schema/export"
```

---

## Task 10: Runbook — `docs/STAGING.md`

**Files:**
- Create: `docs/STAGING.md`
- Modify: `README.md` (link the runbook under Documentation)

- [ ] **Step 1: Write `docs/STAGING.md`** covering, in full prose (no placeholders): the architecture (preview env + `ofarim-staging` + `ENVIRONMENT` flag); the exact list of staging behaviors and their gates; how testers get an OTP (`dev_otp` in the response / banner) and admin entry (`POST /staging/admin-login` with `X-Staging-Token`); the seed endpoint usage; the **instant rollback protocol** (below); and the **branch protection** rule (below).

  **Rollback protocol (Cloudflare Pages native, <60s):** Dashboard → Workers & Pages → **ofarim** → Deployments → pick the last-known-good production deployment → **⋯ → Rollback to this deployment**. This re-points the production alias instantly; no rebuild. (CLI alternative: `wrangler pages deployment list --project-name ofarim` to find the id, then roll back via the dashboard.) Document that rollback only affects code/assets — D1 data changes are not reverted by it.

  **Branch protection:** All feature work happens on branches → preview deploys → `staging` branch for QA sign-off → PR into `main`. Direct pushes to `main` are disallowed (GitHub branch protection, Task 11).

  **Secrets matrix:** which secrets the Preview environment needs (`JWT_SECRET`, `CRON_SECRET`, `STAGING_ADMIN_TOKEN`, `INIT_ADMIN_PASSWORD`) and which it does **not** (`BREVO_API_KEY`, `TURNSTILE_SECRET_KEY` are bypassed in staging).

- [ ] **Step 2: Link it** in `README.md` under the Documentation list:

```markdown
- [docs/STAGING.md](docs/STAGING.md) — staging/QA environment, rollback & branch protection
```

- [ ] **Step 3: Commit**

```bash
git add docs/STAGING.md README.md
git commit -m "docs(staging): STAGING runbook (rollback, branch protection, secrets, usage)"
```

---

## Task 11: Provision the Preview environment + `staging` branch + branch protection

Infra/process — done once, mostly outside the code. Commands assume the wrangler user is authenticated (it is — used earlier this session).

- [ ] **Step 1: Set Preview-environment secrets.** Via the Cloudflare dashboard → **ofarim** → Settings → **Variables and Secrets** → environment toggle = **Preview**, add: `JWT_SECRET` (a fresh value, distinct from prod), `CRON_SECRET`, `STAGING_ADMIN_TOKEN` (a long random string), `INIT_ADMIN_PASSWORD`. Confirm `ENVIRONMENT=staging` is present as a **Preview** plain-text variable (from `wrangler.toml`; if it didn't apply, add it here).

- [ ] **Step 2: Confirm the Preview D1 binding** points at `ofarim-staging` (dashboard → Settings → Functions → D1 bindings → **Preview** tab). This is the fallback if the `wrangler.toml` `[env.preview]` binding didn't take.

- [ ] **Step 3: Create and push the `staging` branch**

```bash
git checkout -b staging
git push -u origin staging
```
Expected: Cloudflare auto-builds a preview at `https://staging.ofarim.pages.dev`.

- [ ] **Step 4: Deploy-time verification (data isolation + flag).** Use the admin backdoor to prove staging is wired to the staging DB and the flag is on:

```bash
curl -s -X POST https://staging.ofarim.pages.dev/api/staging/admin-login \
  -H 'X-Staging-Token: <STAGING_ADMIN_TOKEN>'
# Expected: { token, admin } — proves ENVIRONMENT=staging (route exists) + STAGING_ADMIN_TOKEN set.

curl -s -o /dev/null -w "%{http_code}\n" -X POST https://ofarim.pages.dev/api/staging/admin-login \
  -H 'X-Staging-Token: anything'
# Expected: 404 — proves the staging namespace does NOT exist in production.

curl -s "https://staging.ofarim.pages.dev/api/events/public?month=6&year=2026"
# Expected: [] (empty) — staging DB has no events, confirming it is NOT the prod DB.
```

- [ ] **Step 5: Protect `main`.** GitHub → repo Settings → Branches → add a rule for `main`: require a pull request before merging, disallow direct pushes. (Document in `docs/STAGING.md`; this is a one-time GitHub setting.)

- [ ] **Step 6: Confirm crons only hit prod.** Verify `.github/workflows/cleanup-holds-cron.yml` and `send-reminders-cron.yml` target `https://ofarim.pages.dev` (not the staging host). No change expected; just confirm.

---

## NOT in scope (documented as future hooks)

- **Media/file isolation** — the app currently has **no** file storage (no R2 bucket, no uploads; event imagery is a `color` field). When uploads are added, create `ofarim-staging` R2 and bind it under `[env.preview]` exactly like the D1 binding. Nothing to build now.
- **Analytics isolation** — there are **no** analytics/pixel scripts in the frontend today. When added, wrap them in the same hostname check used by `staging-banner.js` (load only on the production host). Nothing to build now.

---

## Self-review

- **Spec coverage:** data isolation (T2), block OTP/email (T3), instant cart-expiry (T5), stack traces (T1), disable Turnstile/cooldown/attempt-lock (T3/T4), admin backdoor (T6), seed generator (T7), staging 404-in-prod (T6), rollback + branch protection (T10/T11), banner/analytics-future + media-future (T8 / NOT-in-scope). All PRD rows mapped.
- **Placeholder scan:** none — every code/command step is concrete.
- **Type/name consistency:** `isStaging(c)` used uniformly; `ENVIRONMENT`, `STAGING_ADMIN_TOKEN`, `dev_otp`, `/staging/admin-login`, `/staging/seed` consistent across tasks; `generateToken(payload, role, secret)` and `constantTimeEqual` match existing signatures.
- **Safety:** every behavior gated on `isStaging(c)`; `/staging/*` 404s in prod; backdoor needs a separate secret; shared auth primitives unchanged.
