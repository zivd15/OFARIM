# Architecture

OFARIM is an events & registration platform on Cloudflare's edge. A single catch-all
Pages Function hosts the entire Hono API; a D1 (SQLite) database is the only datastore.

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Pages (ofarim)                  │
│                                                              │
│  Static frontend (public/)        Pages Function (edge)      │
│  ┌──────────────────────┐         ┌──────────────────────┐  │
│  │ index.html  (landing) │  fetch  │ functions/api/        │  │
│  │ login.html  (OTP)     │ ───────▶│   [[path]].js         │  │
│  │ calendar.html (events)│  /api/* │   (Hono app)          │  │
│  │ dashboard.html (user) │ ◀────── │                       │  │
│  │ admin.html  (admin)   │  JSON   │  JWT · OTP · booking  │  │
│  └──────────────────────┘         └──────────┬───────────┘  │
│                                               │ binding: DB  │
└───────────────────────────────────────────────┼─────────────┘
              external: Brevo, Turnstile  ┌──────▼───────┐
                                          │  D1 (SQLite) │
                                          └──────────────┘
```

## Request lifecycle

`functions/api/[[path]].js` exports `onRequest(context)`, which forwards every
`/api/*` request into a Hono app (`new Hono().basePath('/api')`). Hono does the
routing; D1 is reached via `c.env.DB`. Static assets are served directly by Pages.

## Data model (`schema.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `admins` | Admin accounts | `email` (unique), `password` (PBKDF2) |
| `users` | End-user accounts (passwordless) | `email` (unique), `otp_code`, `otp_expires_at`, `otp_attempts` |
| `events` | Calendar events | `price` (agorot), `max_participants`, `current_participants` |
| `participants` | Registrations | `status`, `user_id`, `created_at`, FK→`events` (cascade) |

### `events`
- `max_participants` — capacity. **`0` = unlimited** (no cap).
- `price` — **stored in agorot** (1 ₪ = 100 agorot; `5000` = ₪50). `0` = free.
- `current_participants` — authoritative counter of **held seats** (`pending` + `confirmed`),
  maintained atomically. Capacity is enforced against this column, never a `COUNT(*)`.

### `participants.status` — booking state machine
```
pending ──pay──▶ confirmed
   │
   └──15 min, unpaid──▶ expired   (seat released)

(event full at hold time) ──▶ waitlisted
```
- `pending` — seat held, awaiting payment (15-minute window).
- `confirmed` — paid, or a free-event registration (instant).
- `waitlisted` — event was full when they registered (no seat counted).
- `expired` — hold lapsed unpaid; excluded from all active counts.

## The booking engine

Concurrency-safe seat allocation on SQLite, designed to **never overbook**.

### Atomic seat hold (`POST /events/:id/register`)
A single conditional UPDATE both checks capacity and claims the seat — only one
concurrent request can cross each threshold:
```sql
UPDATE events
   SET current_participants = current_participants + 1
 WHERE id = ? AND (max_participants = 0 OR current_participants < max_participants)
 RETURNING id;
```
- Row returned → seat secured. **Free event** → insert `confirmed` (instant). **Paid** → insert `pending` (15-min Bit window).
- No row → event full → insert `waitlisted`.

### The sweeper (`POST /api/internal/cleanup-holds`)
A cron target (protected by `CRON_SECRET`) that releases unpaid holds:
```sql
UPDATE participants SET status = 'expired'
 WHERE status = 'pending' AND created_at < datetime('now', '-15 minutes')
 RETURNING event_id;
```
`RETURNING` yields exactly the rows it flipped (never touches a hold confirmed
mid-sweep). The function then aggregates per event and releases seats with one
clamped, batched decrement each: `current_participants = MAX(current_participants - n, 0)`.

### Payment confirmation (`POST /events/:id/confirm-payment`)
Transitions a hold to paid. The seat was already counted at hold time, so **no
counter change** is needed (no double-count):
```sql
UPDATE participants SET status = 'confirmed'
 WHERE id = ? AND event_id = ? AND status = 'pending'
 RETURNING id;
```
Zero rows updated (expired/invalid) → `400 "Hold expired or invalid"`.

> **Waitlist auto-promotion is intentionally not implemented** — moving a user to
> `pending` without an instant notification would let them silently expire. It waits
> on the notification integration.

## Pricing (agorot)

Prices are stored as integer **agorot** so external payment gateways stay exact.
The admin UI works in ILS; `ilsToAgorot()` converts on write (`Math.round(ils * 100)`),
and the frontends divide by 100 for display. `price = 0` means free → instant confirm,
bypassing the seat-hold payment window.

## Authentication

Two realms share one HS256 JWT scheme (a `role` claim distinguishes them); the secret
comes from `env.JWT_SECRET` and the app **fails closed** if it's missing.

### Admin — password
`POST /auth/login` verifies a PBKDF2 hash and issues a `role: "admin"` JWT.
The first admin is created once via `POST /setup-admin` (gated by `INIT_ADMIN_PASSWORD`).
There is **no** auto-seeded default admin.

### User — passwordless OTP
1. **`POST /user-auth/request-otp`** — Turnstile gate → 60s cooldown → Brevo email →
   stores a 6-digit code (10-min expiry). Neutral 200 (no email enumeration).
2. **`POST /user-auth/verify-otp`** — atomically increments an attempt counter, checks
   the code (constant-time) and expiry, and on success clears the code and issues a
   `role: "user"` JWT. **Max 5 attempts**, then the code is burned.

See [SECURITY.md](SECURITY.md) for the full security model.

## Frontend

Plain HTML served by Pages; tokens live in browser storage and pages redirect on their
presence. `admin.html` and `calendar.html` are React (Babel-in-browser, Tailwind CDN);
`login.html`, `index.html`, `dashboard.html` are vanilla JS with a Hebrew/RTL aesthetic.

| Page | Role | Token storage |
|---|---|---|
| `login.html` | User OTP login (Turnstile) | `localStorage.ofarim_user_token` |
| `dashboard.html` | User "my events" | `localStorage.ofarim_user_token` |
| `calendar.html` | Public calendar + registration | `localStorage` (optional) |
| `admin.html` | Admin panel | `sessionStorage.ofarim_admin_token` |
