# Changelog

Build history of the OFARIM backend/frontend hardening & feature work. Steps are
feature milestones, not semver releases.

## Step 10 — Security & reliability hardening
- **Admin-role gate**: every event-management route (`GET/POST/PUT/DELETE /events…`,
  `GET /events/:id`, `…/participants/:pid`) now requires a `role:"admin"` JWT via
  `adminMiddleware`. Previously they used `authMiddleware`, so **any** authenticated user
  could read all participants or mutate events.
- **Email HTML-escaping**: confirmation/reminder email builders `escapeHtml()` all
  participant- and admin-supplied values, closing an injection/phishing vector (the
  `register` endpoint lets the caller control both the recipient and the `name`).
- **Constant-time** Bearer compare on `POST /internal/send-reminders` (matches
  `cleanup-holds`); `500` (fail closed) if `CRON_SECRET` is unset.
- **Couple-hold sweep fix**: the expiry sweeper now releases the correct seat count by
  **summing `spots`** (a couple hold = 2) instead of counting rows, and reconciles
  `current_participants` against active spots for affected events.
- **Auto-link on login**: `verify-otp` adopts the caller's anonymous (`user_id IS NULL`)
  non-expired registrations by email via `UPDATE OR IGNORE`, so registrations made while
  logged out appear in the personal area. Best-effort; never blocks sign-in.
- **Pinned `@babel/standalone@7.26.4`** on `calendar.html` / `admin.html` — the unpinned
  CDN had rolled to a breaking Babel 8, which failed to compile the in-browser JSX and
  left both React pages blank.

## Step 9 — Confirmation & 24-hour reminder emails
- `events.confirmation_message` + `reminder_message`, `participants.reminder_sent`
  (migration `0010`); per-event text edited in the admin form (empty = don't send).
- Confirmation email (Brevo) on free-event registration and on admin `confirm-payment`.
- `POST /api/internal/send-reminders` (GitHub Actions cron, `CRON_SECRET`) emails
  confirmed participants of events happening **tomorrow**, then sets `reminder_sent`.

## Step 8 — Couple tickets, payment links & notes
- **Couple registration** (migration `0007`): `events.allow_couples` + `couple_price`;
  `participants.ticket_type` (`single`|`couple`) + `spots` (1|2). The seat hold increments
  by `spots`; a partial unique index (`uniq_participants_user_event_active`) blocks
  duplicate **active** registrations while allowing re-registration after an expired hold.
- **Per-event payment link** (migration `0008`, `events.payment_link`) — Bit/PayBox URL
  shown in the post-registration UI.
- **Registration notes** (migration `0009`, `participants.notes`) — optional free-text on
  the registration form, surfaced in the admin participants modal.

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
