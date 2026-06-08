# Security Model

OFARIM is built fail-closed: missing security configuration causes errors, never an
open door. This document summarizes the controls and the known residual risks.

## JWT (HS256)

- Signed/verified with `env.JWT_SECRET`. **There is no hardcoded fallback** — if the
  secret is unset, `jwtSecret()` throws and the request returns `500`
  (`FATAL: JWT_SECRET environment variable is missing.`). The app fails closed.
- 7-day expiry; `role` claim is `"admin"` or `"user"`.
- Auth middleware resolves the secret *outside* the verify try/catch, so a missing
  secret is a `500`, never silently downgraded to a `403`.

## CORS

Locked to an allowlist: `http://localhost:8788` and any `https://*.pages.dev`
(validated via parsed `URL`, not substring match). Other browser origins receive no
`Access-Control-Allow-Origin` header. Allowed headers: `Content-Type`, `Authorization`.

## Admin accounts

- **No auto-seeded default admin** and no credentials in `schema.sql`.
- The first admin is created once via `POST /setup-admin`, gated by `INIT_ADMIN_PASSWORD`
  (compared **constant-time**). It refuses to run if any admin already exists.
- Passwords are hashed with **PBKDF2-SHA-256, 100k iterations**, per-password salt.

## User auth — passwordless OTP

Defense in depth around a 6-digit code:

| Control | Mechanism |
|---|---|
| **Bot protection** | Cloudflare **Turnstile** verified server-side (`/siteverify`) before any DB work or email send. 403 on failure; 500 if `TURNSTILE_SECRET_KEY` unset. |
| **Brute force** | `otp_attempts` counter, **max 5** tries per code. Atomic increment via `UPDATE … RETURNING`; on the 5th failure the code is **burned** (nullified). |
| **Constant-time compare** | The submitted code is compared with `constantTimeEqual()`, not SQL `=`. |
| **Replay / reuse** | Verify is a single atomic statement that matches + expiry-checks + clears the code; a code can't be used twice even under concurrency. |
| **Code lifetime** | 10-minute expiry (`otp_expires_at`). |
| **Email-bomb / quota** | **60-second cooldown** per email — a fresh code can't be requested while a live one has >9 minutes left. Returns `429`. |
| **Enumeration** | `request-otp` returns a neutral 200 regardless of whether the email exists. |

> The legacy `users.password` column is vestigial (`''` for OTP users) and can never
> satisfy `verifyPassword`, which requires a `pbkdf2:` prefix.

## Booking integrity

- **No overbooking**: capacity is enforced by an atomic conditional `UPDATE` on
  `events.current_participants`, not a read-then-write `COUNT(*)`.
- **No double-count**: `pending → confirmed` doesn't touch the counter (the seat was
  counted at hold time). The sweeper releases seats with a clamped decrement
  (`MAX(current_participants - n, 0)`).
- **Anti-IDOR**: `register` ignores any client-supplied `user_id`; ownership is taken
  only from the JWT.

## Webhook / cron endpoints

- `POST /internal/cleanup-holds` — `Authorization: Bearer <CRON_SECRET>`, constant-time;
  `500` (fail closed) if `CRON_SECRET` is unset, `403` on mismatch.
- `POST /events/:id/confirm-payment` — `X-Webhook-Secret` (constant-time) **or** a valid
  admin JWT.

## Residual risks / TODO

These are known, deliberately deferred, and worth addressing before scale:

1. **`request-otp` has no rate limit beyond Turnstile + the per-email cooldown.** A
   determined attacker with solved tokens could still trigger sends to many addresses.
   Consider per-IP limiting (Cloudflare WAF/rate-limiting rules).
2. **Cooldown enumeration** — a `429` reveals that an email recently requested a code.
3. **Cooldown concurrency** — the cooldown is a `SELECT`-then-act check; a tight
   concurrent burst could pass twice. Each still needs its own Turnstile token. An atomic
   `ON CONFLICT … DO UPDATE … WHERE … RETURNING` would close it fully.
4. **Sender domain** must be Brevo-verified (SPF/DKIM) or OTP email lands in spam.
5. **Self-XSS in OTP email** — the user's own `name` is interpolated into the email HTML
   sent only to themselves; not an exploitable vector, but sanitize if reused elsewhere.

## Required secrets

See [DEPLOYMENT.md](DEPLOYMENT.md). Missing any of these fails closed on the relevant
route: `JWT_SECRET`, `INIT_ADMIN_PASSWORD`, `CRON_SECRET`, `WEBHOOK_SECRET`,
`TURNSTILE_SECRET_KEY`, `BREVO_API_KEY`.
