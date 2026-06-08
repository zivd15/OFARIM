# Changelog

Build history of the OFARIM backend/frontend hardening & feature work. Steps are
feature milestones, not semver releases.

## Step 7 — Rate limiting & Brevo email
- `POST /user-auth/request-otp`: **60-second cooldown** per email (`429` with a Hebrew
  message) to protect email quota.
- Wired **Brevo** (`https://api.brevo.com/v3/smtp/email`) for OTP delivery, gated by
  `BREVO_API_KEY` (500 if missing). Email is sent **before** the code is persisted, so a
  delivery failure doesn't trap the user behind the cooldown.

## Step 6 — Anti-bot shield (Turnstile + attempt limiter)
- `users.otp_attempts` column (migration `0005`).
- Cloudflare **Turnstile** verification on `request-otp` (server-side `/siteverify`,
  `TURNSTILE_SECRET_KEY`); widget added to `login.html`.
- `verify-otp`: atomic attempt increment, **max 5 tries**, constant-time compare, code
  burned on lockout.

## Step 5 — Public calendar polish & passwordless OTP
- `calendar.html`: price badge (green `חינם` for free, black `₪X` for paid).
- `users.otp_code` / `otp_expires_at` columns (migration `0004`); `password` made vestigial.
- Replaced user register/login with `POST /user-auth/request-otp` and
  `POST /user-auth/verify-otp` (atomic verify that matches + expiry-checks + clears in one
  statement).
- `login.html` rewritten as a 2-step passwordless flow.

## Step 4 — Admin dashboard segregation & agorot
- Prices standardized to **agorot** (migration `0003`); `ilsToAgorot()` on write.
- Segmented counts (`confirmed_count` / `pending_count` / `waitlist_count`, `expired`
  excluded) on `GET /events/public`, `GET /events`, `GET /events/:id`.
- `admin.html`: price input (ILS↔agorot), per-event status badges, participants modal
  segregated by status, **Confirm Payment** button with optimistic UI.

## Step 3 — Payment reconciliation & free events
- `events.price` column (migration `0002`).
- Free events (`price = 0`) bypass the Bit hold and insert `confirmed` instantly.
- `POST /events/:id/confirm-payment` (admin JWT **or** `WEBHOOK_SECRET`) transitions
  `pending → confirmed`.

## Step 2 — Atomic booking engine & seat holds
- `events.current_participants`; `participants.status` + `created_at` (migration `0001`).
- Atomic seat hold (no overbooking) + waitlist on `POST /events/:id/register`.
- `POST /internal/cleanup-holds` sweeper (cron, `CRON_SECRET`) expires unpaid holds after
  15 minutes and releases seats.

## Step 1 — Security-first hardening
- Removed the hardcoded JWT fallback secret — app **fails closed** without `JWT_SECRET`.
- Restricted **CORS** to `localhost:8788` + `*.pages.dev`.
- Strict data isolation / anti-IDOR (ownership from JWT only).
- Removed the auto-seeded default admin; added `POST /setup-admin` gated by
  `INIT_ADMIN_PASSWORD`.
