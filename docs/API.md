# API Reference

All routes are served by `functions/api/[[path]].js` under the base path `/api`.
Request/response bodies are JSON unless noted. CORS is restricted to `http://localhost:8788`
and `https://*.pages.dev`.

**Auth legend**
- 🔓 Public
- 👤 User JWT (`Authorization: Bearer <token>`)
- 🛡️ Admin JWT
- 🤖 Webhook secret (`X-Webhook-Secret`) **or** Admin JWT
- 🔑 Shared secret (Bearer must equal an env secret)

---

## Bootstrap & internal

### 🔑 `POST /api/setup-admin`
Create the **first** admin (one-time). Gated by `INIT_ADMIN_PASSWORD`.
```json
{ "secret": "<INIT_ADMIN_PASSWORD>", "email": "you@example.com", "password": "min 8 chars", "name": "Optional" }
```
- `201` → `{ message, admin: { id, email } }`
- `403` → initialization disabled, wrong secret, or an admin already exists.

### 🔑 `POST /api/internal/cleanup-holds`
Sweeper that expires unpaid `pending` holds older than 12 hours and releases their seats.
Intended for a Cloudflare Cron Trigger. Requires `Authorization: Bearer <CRON_SECRET>`.
Releases seats by **summing `spots`** (couple holds free 2), then reconciles
`current_participants` against active spots for affected events.
- `200` → `{ expired, events_released }`
- `403` mismatch · `500` if `CRON_SECRET` is unset.

### 🔑 `POST /api/internal/send-reminders`
Emails confirmed participants of events happening **tomorrow** whose `reminder_message`
is set, then flags `reminder_sent`. Driven by a GitHub Actions cron. Requires
`Authorization: Bearer <CRON_SECRET>` (constant-time).
- `200` → `{ reminded }`
- `403` mismatch · `500` if `CRON_SECRET` is unset.

---

## Admin auth

### 🔓 `POST /api/auth/login`
```json
{ "email": "admin@example.com", "password": "..." }
```
- `200` → `{ user: { id, name, email }, token }`  ·  `401` invalid credentials.

### 🛡️ `GET /api/auth/me`
Returns the signed-in admin `{ id, name, email }`.

---

## User auth (passwordless OTP)

### 🔓 `POST /api/user-auth/request-otp`
```json
{ "email": "user@example.com", "name": "Optional", "cf-turnstile-response": "<token>" }
```
Flow: Turnstile verify → 60s cooldown → Brevo email → store code (10-min expiry).
- `200` → neutral `{ message }` (no email enumeration)
- `400` missing email · `403` bot verification failed · `429` cooldown (`נא להמתין 60 שניות…`)
- `500` `TURNSTILE_SECRET_KEY` or `BREVO_API_KEY` unset, or email send failed.

### 🔓 `POST /api/user-auth/verify-otp`
```json
{ "email": "user@example.com", "code": "123456" }
```
Atomic attempt-count + constant-time check; **max 5 attempts**, then the code is burned.
On success, **auto-links** the caller's anonymous (`user_id IS NULL`) non-expired
registrations to this account by email (`UPDATE OR IGNORE`), so registrations made while
logged out appear under `/events/my-events`. Best-effort — never blocks login.
- `200` → `{ user: { id, name, email, phone }, token }`
- `401` invalid/expired/locked.

### 👤 `GET /api/user-auth/me`
Returns the signed-in user `{ id, name, email, phone }`.

---

## Events — public

### 🔓 `GET /api/events/public?month=&year=`
Events (optionally filtered by month/year) with segmented counts.
```json
[{ "id", "title", "date", "time", "end_time", "description", "location", "color",
   "max_participants", "price", "current_participants",
   "confirmed_count", "pending_count", "waitlist_count",
   "participant_count", "spots_left" }]
```
`price` is in agorot (divide by 100 for ₪). `spots_left` is `null` for unlimited events.

### 👤 `GET /api/events/my-events`
Events the authenticated user is registered for.

### 🔓 `GET /api/events/:id/calendar.ics`
Downloads an `.ics` calendar file for the event.

### 🔓 `POST /api/events/:id/register`
Register (anonymous or authenticated). Body: `{ name, phone?, email?, ticket_type?, notes? }`
— `ticket_type` is `"single"` (default) or `"couple"` (holds 2 `spots`; rejected if the
event has `allow_couples = 0`). Any client-supplied `user_id` is **ignored** (ownership
comes from the JWT) — anti-IDOR. Anonymous rows (`user_id NULL`) are later **auto-linked**
on login by email (see `verify-otp`).
- `200` → `{ status: "confirmed" }` (free) · `{ status: "pending" }` (paid, 15-min hold) · `{ status: "waitlisted" }` (full)
- `400` missing name / couple not allowed · `404` event not found · `409` already registered.

### 🤖 `POST /api/events/:id/confirm-payment`
Confirm a pending hold (manual admin approval **or** payment webhook).
Body: `{ "participant_id": <id> }`.
- `200` → `{ message: "Payment confirmed", participant_id }`
- `400` `"Hold expired or invalid"` (no matching pending hold) · `403` unauthorized.

---

## Events — admin (🛡️ all require admin JWT)

### `GET /api/events?month=&year=`
Events with full `participants` arrays (excluding `expired`) and segmented counts.

### `GET /api/events/:id`
One event with its participants and segmented counts.

### `POST /api/events`
Create. Body: `{ title*, date* (YYYY-MM-DD), time?, end_time?, description?, location?, color?, max_participants?, price? }`.
`price` is sent in **ILS** and converted to agorot server-side.

### `PUT /api/events/:id`
Update (partial; omitted fields keep existing values). `price` in ILS.

### `DELETE /api/events/:id`
Delete an event (cascades to its participants).

### `DELETE /api/events/:id/participants/:pid`
Remove a single participant from an event.
