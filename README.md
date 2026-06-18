# OFARIM (עופרים) — Events & Calendar Management

A Hebrew-first (RTL) events & registration platform running entirely on Cloudflare's
edge. No separate backend server, no frontend build step.

> גדולים יותר, חזקים יותר, חכמים יותר וטובי לב

## Stack

| Layer | Technology |
|---|---|
| Hosting / compute | Cloudflare **Pages** + a single catch-all **Pages Function** |
| API framework | [Hono](https://hono.dev) v4 (base path `/api`) |
| Database | Cloudflare **D1** (SQLite), bound as `DB` |
| Frontend | Static HTML + vanilla JS; `admin.html` & `calendar.html` use React-via-Babel (CDN) |
| Auth — admin | Email + password (PBKDF2), HS256 JWT |
| Auth — user | **Passwordless OTP** by email (Brevo) + Cloudflare Turnstile |
| Email | [Brevo](https://www.brevo.com) HTTP API — OTP codes + per-event confirmation & 24h reminder emails |
| Payments | Seat-hold booking engine, per-event Bit/PayBox link, agorot pricing, single & couple tickets |
| CI/CD | GitHub Actions → `wrangler pages deploy` on push to `main` |

## Repository layout

```
OFARIM/
├── functions/api/[[path]].js   # The entire API (Hono app, catch-all route)
├── public/                     # Static frontend
│   ├── index.html              # Landing
│   ├── login.html              # Passwordless OTP login (2-step + Turnstile)
│   ├── calendar.html           # Public month calendar + registration
│   ├── dashboard.html          # User "my area"
│   └── admin.html              # Admin panel (events, participants, payments)
├── migrations/                 # Incremental SQL migrations (run in order)
├── schema.sql                  # Canonical DDL for a fresh database
├── wrangler.toml               # Pages + D1 binding config
└── docs/                       # Architecture, API, security, deployment
```

## Quick start (local)

```bash
npm install

# First time only: create the D1 database and apply the schema
npm run db:create          # creates the "ofarim" D1 database
npm run db:init            # applies schema.sql to the LOCAL db

npm run dev                # wrangler pages dev → http://localhost:8788
```

Local dev needs a few secrets in a `.dev.vars` file (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
At minimum `JWT_SECRET`; for the OTP flow also `TURNSTILE_SECRET_KEY` and `BREVO_API_KEY`.

## NPM scripts

| Script | What it does |
|---|---|
| `npm run dev` | Local Pages dev server at `http://localhost:8788` |
| `npm run deploy` | `wrangler pages deploy public` |
| `npm run db:create` | Create the `ofarim` D1 database |
| `npm run db:init` | Apply `schema.sql` to the **local** D1 |
| `npm run db:init:remote` | Apply `schema.sql` to the **remote** D1 |

## First-run bootstrap

1. Apply the schema (fresh DB) **or** run the migrations (existing DB) — see
   [migrations/README.md](migrations/README.md).
2. Set the required secrets — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
3. Create the first admin via the one-time endpoint:
   ```bash
   curl -X POST https://<your-app>.pages.dev/api/setup-admin \
     -H 'Content-Type: application/json' \
     -d '{"secret":"<INIT_ADMIN_PASSWORD>","email":"you@example.com","password":"<min 8 chars>"}'
   ```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, data model, booking engine, auth
- [docs/API.md](docs/API.md) — full endpoint reference
- [docs/SECURITY.md](docs/SECURITY.md) — security model & hardening
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — env vars, secrets, migrations, deploy
- [migrations/README.md](migrations/README.md) — migration run order
- [CHANGELOG.md](CHANGELOG.md) — build history (Steps 1–10)
