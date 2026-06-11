import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'

const app = new Hono().basePath('/api')

// ── CORS (restricted) ─────────────────────────────────────────────────────────
// Allow only local dev (http://localhost:8788) and production *.pages.dev.
// Any other browser origin receives no Access-Control-Allow-Origin header and
// is blocked by the browser. Same-origin / non-browser callers (no Origin) pass.
const STATIC_ALLOWED_ORIGINS = ['http://localhost:8788']

function resolveAllowedOrigin(origin) {
  if (!origin) return undefined                       // same-origin / server-to-server
  if (STATIC_ALLOWED_ORIGINS.includes(origin)) return origin
  try {
    const { protocol, hostname } = new URL(origin)
    if (protocol === 'https:' && hostname.endsWith('.pages.dev')) return origin
  } catch { /* malformed Origin → blocked */ }
  return undefined                                    // not on the allowlist → blocked
}

app.use('*', cors({
  origin: (origin) => resolveAllowedOrigin(origin),
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// Consistent JSON for every failure path so the frontend's `res.json()` never throws
// on an unexpected HTML/text body (which would hang the UI).
app.notFound(c => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()   // preserves our JSON 500s (e.g. missing JWT_SECRET)
  console.error('Unhandled error:', err?.message || err)
  return c.json({ error: 'Internal server error' }, 500)
})

// ── JWT ──────────────────────────────────────────────────────────────────────

function b64url(str) {
  // btoa() only handles Latin-1; encode to UTF-8 bytes first so Hebrew names work.
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  bytes.forEach(b => { binary += String.fromCharCode(b) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
function b64urlBytes(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function signJWT(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const data = `${header}.${body}`
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return `${data}.${b64urlBytes(new Uint8Array(sig))}`
}

async function verifyJWT(token, secret) {
  const [header, body, sig] = token.split('.')
  if (!header || !body || !sig) throw new Error('Invalid token')
  const data = `${header}.${body}`
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  )
  const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data))
  if (!valid) throw new Error('Invalid signature')
  const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired')
  return payload
}

function jwtSecret(env) {
  // Fail closed: never fall back to a hardcoded secret. A missing JWT_SECRET is
  // a fatal misconfiguration, not something to silently work around.
  if (!env.JWT_SECRET) {
    throw new HTTPException(500, {
      res: new Response(
        JSON.stringify({ error: 'FATAL: JWT_SECRET environment variable is missing.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      ),
    })
  }
  return env.JWT_SECRET
}

async function generateToken(user, role, secret) {
  return signJWT(
    { id: user.id, email: user.email, name: user.name, role, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 },
    secret
  )
}

// ── Password ─────────────────────────────────────────────────────────────────

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  )
  const toHex = arr => Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
  return `pbkdf2:${toHex(salt)}:${toHex(new Uint8Array(bits))}`
}

async function verifyPassword(password, stored) {
  if (!stored.startsWith('pbkdf2:')) return false
  const [, saltHex, hashHex] = stored.split(':')
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  )
  const computed = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
  return computed === hashHex
}

// ── Auth middleware ───────────────────────────────────────────────────────────

async function authMiddleware(c, next) {
  const secret = jwtSecret(c.env)   // throws 500 (fail closed) if JWT_SECRET is missing
  const token = c.req.header('authorization')?.split(' ')[1]
  if (!token) return c.json({ error: 'Authentication required' }, 401)
  let payload
  try {
    payload = await verifyJWT(token, secret)
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 403)
  }
  c.set('user', payload)
  await next()
}

async function optionalAuthMiddleware(c, next) {
  const secret = jwtSecret(c.env)   // throws 500 (fail closed) if JWT_SECRET is missing
  const token = c.req.header('authorization')?.split(' ')[1]
  if (token) {
    try { c.set('user', await verifyJWT(token, secret)) } catch {}
  }
  await next()
}

// Authorize either a payment webhook (X-Webhook-Secret == env.WEBHOOK_SECRET) or
// an admin JWT. Used by endpoints that must serve both automated clearing and
// manual dashboard approval. Returns { ok, via } — never throws on bad creds.
async function isAdminOrWebhook(c) {
  const webhookSecret = c.env.WEBHOOK_SECRET
  const provided = c.req.header('x-webhook-secret')
  if (webhookSecret && provided && constantTimeEqual(provided, webhookSecret)) {
    return { ok: true, via: 'webhook' }
  }
  const token = c.req.header('authorization')?.split(' ')[1]
  if (token) {
    const secret = jwtSecret(c.env)   // throws 500 (fail closed) if JWT_SECRET is missing
    try {
      const payload = await verifyJWT(token, secret)
      if (payload.role === 'admin') return { ok: true, via: 'admin', user: payload }
    } catch { /* invalid/expired token → unauthorized */ }
  }
  return { ok: false }
}

// ── Constant-time compare (init secret) ───────────────────────────────────────
// Used to compare the supplied setup secret against INIT_ADMIN_PASSWORD without
// leaking length/byte timing.

function constantTimeEqual(a, b) {
  const enc = new TextEncoder()
  const ba = enc.encode(typeof a === 'string' ? a : '')
  const bb = enc.encode(typeof b === 'string' ? b : '')
  if (ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}

// ── One-time admin initialization (/api/setup-admin) ──────────────────────────
// Gated by the INIT_ADMIN_PASSWORD env secret. Creates the FIRST admin only.
//   403 if initialization is disabled (no env secret), the secret is wrong,
//   or an admin already exists. This replaces the old insecure auto-seed.
app.post('/setup-admin', async c => {
  const initSecret = c.env.INIT_ADMIN_PASSWORD
  if (!initSecret) return c.json({ error: 'Admin initialization is disabled' }, 403)

  const body = await c.req.json().catch(() => ({}))
  const { secret, name, email, password } = body
  if (!constantTimeEqual(secret, initSecret)) {
    return c.json({ error: 'Invalid initialization secret' }, 403)
  }

  // Fail closed if an admin already exists — this endpoint bootstraps the first one only.
  const row = await c.env.DB.prepare('SELECT COUNT(*) as count FROM admins').first()
  if (row.count > 0) return c.json({ error: 'Admin already initialized' }, 403)

  if (!email?.trim()) return c.json({ error: 'Email is required' }, 400)
  if (!password || password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)

  const hash = await hashPassword(password)
  const result = await c.env.DB.prepare('INSERT INTO admins (name, email, password) VALUES (?, ?, ?)')
    .bind(name?.trim() || 'Admin', email.trim().toLowerCase(), hash).run()

  return c.json({ message: 'Admin created', admin: { id: result.meta.last_row_id, email: email.trim().toLowerCase() } }, 201)
})

// ── Internal / cron (/api/internal/*) ─────────────────────────────────────────
// Sweeper that releases unpaid seat holds. Intended to be hit by a Cloudflare
// Cron Trigger. Auth: Bearer token must equal env.CRON_SECRET (constant-time).
app.post('/internal/cleanup-holds', async c => {
  const cronSecret = c.env.CRON_SECRET
  if (!cronSecret) return c.json({ error: 'CRON_SECRET not configured' }, 500)  // fail closed

  const token = c.req.header('authorization')?.split(' ')[1]
  if (!constantTimeEqual(token, cronSecret)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  // Atomically flip every stale pending hold to 'expired' and get back exactly the
  // rows we changed. RETURNING means we never double-count and never touch a hold
  // that was confirmed (paid) between scan and update.
  const { results: expired } = await c.env.DB.prepare(
    `UPDATE participants
        SET status = 'expired'
      WHERE status = 'pending'
        AND created_at < datetime('now', '-15 minutes')
      RETURNING event_id`
  ).all()

  if (!expired.length) return c.json({ expired: 0, events_released: 0 })

  // Aggregate releases per event → one clamped decrement per event in a batch.
  const perEvent = new Map()
  for (const r of expired) perEvent.set(r.event_id, (perEvent.get(r.event_id) || 0) + 1)

  const stmts = [...perEvent.entries()].map(([eventId, n]) =>
    c.env.DB.prepare(
      'UPDATE events SET current_participants = MAX(current_participants - ?, 0) WHERE id = ?'
    ).bind(n, eventId)
  )
  await c.env.DB.batch(stmts)

  return c.json({ expired: expired.length, events_released: perEvent.size })
})

// ── Admin auth (/api/auth/*) ──────────────────────────────────────────────────

app.post('/auth/login', async c => {
  const { email, password } = await c.req.json()
  if (!email || !password) return c.json({ error: 'Email and password are required' }, 400)

  const admin = await c.env.DB.prepare('SELECT * FROM admins WHERE email = ?').bind(email.trim().toLowerCase()).first()
  if (!admin || !(await verifyPassword(password, admin.password))) {
    return c.json({ error: 'Invalid email or password' }, 401)
  }
  const token = await generateToken({ id: admin.id, email: admin.email, name: admin.name }, 'admin', jwtSecret(c.env))
  return c.json({ user: { id: admin.id, name: admin.name, email: admin.email }, token })
})

app.get('/auth/me', authMiddleware, async c => {
  const admin = await c.env.DB.prepare('SELECT id, name, email FROM admins WHERE id = ?').bind(c.get('user').id).first()
  if (!admin) return c.json({ error: 'Admin not found' }, 404)
  return c.json(admin)
})

// ── User auth (/api/user-auth/*) — passwordless OTP ───────────────────────────

// Cryptographically-random 6-digit code. (2^32 % 1e6 bias is negligible here.)
function generateOTP() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0')
}

// Validate a Cloudflare Turnstile token server-side. Returns true only on success.
async function verifyTurnstile(token, secret, ip) {
  if (!token) return false
  const form = new URLSearchParams()
  form.set('secret', secret)
  form.set('response', token)
  if (ip) form.set('remoteip', ip)
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    const data = await resp.json()
    return data.success === true
  } catch {
    return false   // network/parse failure → treat as not verified (fail closed)
  }
}

// Step 1: issue a code. Upserts the user and stashes a 10-minute OTP.
// Always returns a neutral 200 (no email enumeration). The code is logged until
// an email provider is wired — view it with `wrangler pages deployment tail`.
app.post('/user-auth/request-otp', async c => {
  const body = await c.req.json().catch(() => ({}))
  const { email, name } = body
  const turnstileToken = body['cf-turnstile-response'] || body.turnstileToken
  if (!email?.trim()) return c.json({ error: 'Email is required' }, 400)

  // Anti-bot gate: a valid Turnstile token is required before we touch the DB or
  // (later) spend email quota. Fail closed if the secret isn't configured.
  const secret = c.env.TURNSTILE_SECRET_KEY
  if (!secret) return c.json({ error: 'Turnstile is not configured' }, 500)
  const human = await verifyTurnstile(turnstileToken, secret, c.req.header('cf-connecting-ip'))
  if (!human) return c.json({ error: 'Bot verification failed' }, 403)

  const normEmail = email.trim().toLowerCase()

  // 60-second cooldown: a live code with >9 of its 10 minutes left was issued less
  // than a minute ago — refuse to send another and protect our email quota.
  const recent = await c.env.DB.prepare(
    `SELECT 1 AS x FROM users
      WHERE email = ? AND otp_code IS NOT NULL AND otp_expires_at > datetime('now', '+9 minutes')`
  ).bind(normEmail).first()
  if (recent) return c.json({ error: 'נא להמתין 60 שניות לפני בקשת קוד חדש.' }, 429)

  // Email provider must be configured (fail closed).
  const brevoKey = c.env.BREVO_API_KEY
  if (!brevoKey) return c.json({ error: 'Email service is not configured' }, 500)

  const code = generateOTP()

  // Deliver via Brevo BEFORE persisting, so a delivery failure doesn't lock the user
  // behind the cooldown holding a code they never received.
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

  // Persist the code (resets the brute-force counter). password '' is a vestigial
  // placeholder — it can never satisfy verifyPassword (needs a 'pbkdf2:' prefix).
  await c.env.DB.prepare(`
    INSERT INTO users (name, email, phone, password, otp_code, otp_expires_at, otp_attempts)
    VALUES (?, ?, '', '', ?, datetime('now', '+10 minutes'), 0)
    ON CONFLICT(email) DO UPDATE SET
      otp_code = excluded.otp_code,
      otp_expires_at = excluded.otp_expires_at,
      otp_attempts = 0,
      name = COALESCE(NULLIF(excluded.name, ''), users.name)
  `).bind(name?.trim() || '', normEmail, code).run()

  return c.json({ message: 'If that email is valid, a verification code has been sent.' }, 200)
})

// Step 2: verify. One atomic statement matches the code, checks expiry, and clears
// the OTP — so a code can't be replayed or used twice even under concurrency.
const MAX_OTP_ATTEMPTS = 5

app.post('/user-auth/verify-otp', async c => {
  const { email, code } = await c.req.json().catch(() => ({}))
  if (!email?.trim() || !code?.toString().trim()) return c.json({ error: 'Email and code are required' }, 400)
  const normEmail = email.trim().toLowerCase()
  const codeStr = code.toString().trim()

  const row = await c.env.DB.prepare(`
    UPDATE users SET otp_attempts = otp_attempts + 1
     WHERE email = ? AND otp_code IS NOT NULL AND otp_expires_at > datetime('now')
     RETURNING id, name, email, phone, otp_code, otp_attempts
  `).bind(normEmail).first()

  if (!row) return c.json({ error: 'Invalid or expired code' }, 401)

  const withinLimit = row.otp_attempts <= MAX_OTP_ATTEMPTS         // this attempt is the Nth (1..5)
  const matches = constantTimeEqual(codeStr, row.otp_code)         // constant-time, not SQL '='

  if (matches && withinLimit) {
    await c.env.DB.prepare('UPDATE users SET otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = ?')
      .bind(row.id).run()
    const token = await generateToken({ id: row.id, email: row.email, name: row.name }, 'user', jwtSecret(c.env))
    return c.json({ user: { id: row.id, name: row.name, email: row.email, phone: row.phone }, token })
  }

  // Wrong code, or the limit has been reached. At/over the cap, burn the code so the
  // attacker must request a fresh one (and pass Turnstile again).
  if (row.otp_attempts >= MAX_OTP_ATTEMPTS) {
    await c.env.DB.prepare('UPDATE users SET otp_code = NULL, otp_expires_at = NULL WHERE id = ?').bind(row.id).run()
  }
  return c.json({ error: 'Invalid or expired code' }, 401)
})

app.get('/user-auth/me', authMiddleware, async c => {
  const user = await c.env.DB.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').bind(c.get('user').id).first()
  if (!user) return c.json({ error: 'User not found' }, 404)
  return c.json(user)
})

// ── Email helper ─────────────────────────────────────────────────────────────

async function sendBrevoEmail(env, { to, name, subject, htmlContent }) {
  const brevoKey = env.BREVO_API_KEY
  if (!brevoKey) return
  const payload = {
    sender: { name: 'OFARIM', email: 'ofarim.grow@gmail.com' },
    to: [{ email: to }],
    subject,
    htmlContent,
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'api-key': brevoKey, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) console.error('[Brevo] email failed', subject, res.status, await res.text().catch(() => ''))
}

function eventEmailDetails(ev) {
  const heDate = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const [y, m, d] = (ev.date || '').split('-').map(Number)
  const dateStr = y ? heDate.format(new Date(y, m - 1, d)) : ev.date
  const timeStr = ev.time ? ` · ${ev.time}${ev.end_time ? '–' + ev.end_time : ''}` : ''
  const locationStr = ev.location ? ` · ${ev.location}` : ''
  return `${dateStr}${timeStr}${locationStr}`
}

function buildConfirmationEmail(ev, participantName) {
  const details = eventEmailDetails(ev)
  return `<div dir="rtl" style="font-family:Arial,sans-serif;text-align:right;max-width:520px;margin:0 auto;">
    <h2 style="color:#152020;">שלום ${participantName},</h2>
    <p>ההרשמה שלך לאירוע <strong>${ev.title}</strong> אושרה!</p>
    <p style="color:#555;">${details}</p>
    ${ev.confirmation_message ? `<div style="margin:20px 0;padding:16px;background:#f8f9fa;border-right:4px solid #152020;">${ev.confirmation_message.replace(/\n/g,'<br>')}</div>` : ''}
    <p style="color:#999;font-size:12px;margin-top:24px;">עופרים — ofarim.pages.dev</p>
  </div>`
}

function buildReminderEmail(ev, participantName) {
  const details = eventEmailDetails(ev)
  return `<div dir="rtl" style="font-family:Arial,sans-serif;text-align:right;max-width:520px;margin:0 auto;">
    <h2 style="color:#152020;">שלום ${participantName},</h2>
    <p>תזכורת — האירוע <strong>${ev.title}</strong> מתקיים <strong>מחר</strong>!</p>
    <p style="color:#555;">${details}</p>
    ${ev.reminder_message ? `<div style="margin:20px 0;padding:16px;background:#f8f9fa;border-right:4px solid #152020;">${ev.reminder_message.replace(/\n/g,'<br>')}</div>` : ''}
    <p style="color:#999;font-size:12px;margin-top:24px;">עופרים — ofarim.pages.dev</p>
  </div>`
}

// ── Event helper ──────────────────────────────────────────────────────────────

// Prices are stored in agorot (1 ILS = 100 agorot) to stay integer-exact for
// external payment gateways. The admin UI works in ILS; convert on the way in.
function ilsToAgorot(ils) {
  const n = Number(ils)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * 100)
}

// Segmented active counts from an already-fetched participant list (expired excluded).
// Uses SUM of spots so couple registrations (spots=2) count as 2 held seats.
function segmentCounts(participants) {
  const sumSpots = (status) =>
    participants.filter(p => p.status === status).reduce((s, p) => s + (p.spots || 1), 0)
  const confirmed_count = sumSpots('confirmed')
  const pending_count   = sumSpots('pending')
  const waitlist_count  = sumSpots('waitlisted')
  return { confirmed_count, pending_count, waitlist_count, participant_count: confirmed_count + pending_count }
}

function withCounts(_db, event) {
  // current_participants is the authoritative held-seat counter (pending + confirmed),
  // maintained atomically at registration / sweep time — no per-event COUNT needed.
  const held = event.current_participants ?? 0
  return {
    ...event,
    participant_count: held,
    spots_left: event.max_participants > 0 ? Math.max(0, event.max_participants - held) : null,
  }
}

// ── Public events (/api/events/public, /api/events/my-events, /:id/*) ────────

app.get('/events/public', async c => {
  const { month, year } = c.req.query()

  // Conditional aggregation: one query returns each event plus its active counts.
  // Uses SUM(spots) so couple registrations (spots=2) count as 2 held seats.
  // 'expired' rows are never summed, so they're excluded from every count.
  const base = `
    SELECT e.id, e.title, e.date, e.time, e.end_time, e.description, e.location, e.color,
           e.max_participants, e.price, e.current_participants, e.allow_couples, e.couple_price, e.payment_link,
           COALESCE(SUM(CASE WHEN p.status = 'confirmed'  THEN p.spots ELSE 0 END), 0) AS confirmed_count,
           COALESCE(SUM(CASE WHEN p.status = 'pending'    THEN p.spots ELSE 0 END), 0) AS pending_count,
           COALESCE(SUM(CASE WHEN p.status = 'waitlisted' THEN p.spots ELSE 0 END), 0) AS waitlist_count
      FROM events e
      LEFT JOIN participants p ON p.event_id = e.id`

  let stmt
  if (month && year) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endMonth = parseInt(month) === 12 ? 1 : parseInt(month) + 1
    const endYear = parseInt(month) === 12 ? parseInt(year) + 1 : parseInt(year)
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`
    stmt = c.env.DB.prepare(base + ' WHERE e.date >= ? AND e.date < ? GROUP BY e.id ORDER BY e.date, e.time').bind(startDate, endDate)
  } else {
    stmt = c.env.DB.prepare(base + ' GROUP BY e.id ORDER BY e.date, e.time')
  }

  const { results } = await stmt.all()
  return c.json(results.map(e => withCounts(null, e)))
})

app.get('/events/my-events', authMiddleware, async c => {
  // Expose THIS user's registration status per event (confirmed/pending/waitlisted).
  // Expired holds are hidden.
  const { results: events } = await c.env.DB.prepare(`
    SELECT e.*, p.status AS registration_status, p.created_at AS registered_at, p.id AS participant_id
    FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE p.user_id = ? AND p.status != 'expired'
    ORDER BY e.date DESC, e.time DESC
  `).bind(c.get('user').id).all()

  return c.json(events.map(e => withCounts(null, e)))
})

app.get('/events/:id/calendar.ics', async c => {
  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first()
  if (!event) return c.json({ error: 'Event not found' }, 404)

  const fmt = (date, time) => {
    const d = date.replace(/-/g, '')
    if (!time) return d
    return `${d}T${time.replace(/:/g, '').padEnd(6, '0')}`
  }
  const dtStart = fmt(event.date, event.time)
  const dtEnd = event.end_time ? fmt(event.date, event.end_time) : dtStart
  const escIcs = s => (s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')

  let ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ofarim//Events//EN\r\nBEGIN:VEVENT\r\nUID:event-${event.id}@ofarim\r\n`
  ics += event.time ? `DTSTART:${dtStart}\r\nDTEND:${dtEnd}\r\n` : `DTSTART;VALUE=DATE:${dtStart}\r\n`
  ics += `SUMMARY:${escIcs(event.title)}\r\n`
  if (event.description) ics += `DESCRIPTION:${escIcs(event.description)}\r\n`
  if (event.location) ics += `LOCATION:${escIcs(event.location)}\r\n`
  ics += `END:VEVENT\r\nEND:VCALENDAR\r\n`

  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${event.title.replace(/[^a-zA-Z0-9֐-׿ ]/g, '')}.ics"`,
    },
  })
})

app.post('/events/:id/register', optionalAuthMiddleware, async c => {
  // Anti-IDOR: deliberately destructure only profile fields. Any `user_id`
  // (or `id`) sent in the body is ignored — ownership comes from the JWT alone.
  const { name, phone, email, ticket_type: rawTicketType, notes } = await c.req.json()
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)

  const ticketType = rawTicketType === 'couple' ? 'couple' : 'single'
  const spots = ticketType === 'couple' ? 2 : 1

  const event = await c.env.DB.prepare(
    'SELECT id, title, date, time, end_time, location, max_participants, price, allow_couples, couple_price, confirmation_message FROM events WHERE id = ?'
  ).bind(c.req.param('id')).first()
  if (!event) return c.json({ error: 'Event not found' }, 404)

  // Reject couple ticket if the event doesn't allow it.
  if (ticketType === 'couple' && !event.allow_couples) {
    return c.json({ error: 'אירוע זה אינו מאפשר הרשמה זוגית.' }, 400)
  }

  // For couple tickets use couple_price; single tickets use the regular price.
  const effectivePrice = ticketType === 'couple' ? (event.couple_price ?? 0) : (event.price ?? 0)
  const isFree = effectivePrice <= 0

  // Ownership comes from the trusted JWT id only; anonymous registration stores NULL.
  const userId = c.get('user')?.id ?? null

  // Reject duplicates among still-active rows. An 'expired' hold does NOT block a
  // retry, so a user whose Bit window lapsed can register again.
  if (userId) {
    const dup = await c.env.DB.prepare(
      "SELECT id FROM participants WHERE event_id = ? AND user_id = ? AND status != 'expired'"
    ).bind(event.id, userId).first()
    if (dup) return c.json({ error: 'אתה כבר רשום לאירוע זה.' }, 409)
  } else if (phone) {
    const dup = await c.env.DB.prepare(
      "SELECT id FROM participants WHERE event_id = ? AND name = ? AND phone = ? AND status != 'expired'"
    ).bind(event.id, name.trim(), phone.trim()).first()
    if (dup) return c.json({ error: 'אתה כבר רשום לאירוע זה.' }, 409)
  }

  // ── Atomic seat hold ────────────────────────────────────────────────────────
  // Single conditional UPDATE: increment by `spots` (1 or 2) only when enough
  // room remains, so overbooking is impossible even under concurrent requests.
  // max_participants = 0 means unlimited; the hold always succeeds there.
  const held = await c.env.DB.prepare(
    `UPDATE events
        SET current_participants = current_participants + ?
      WHERE id = ?
        AND (max_participants = 0 OR current_participants + ? <= max_participants)
      RETURNING id`
  ).bind(spots, event.id, spots).first()

  // Free events skip the Bit hold: a secured seat is confirmed immediately.
  // Paid events get a 'pending' hold the sweeper can expire after 15 minutes.
  const status = held ? (isFree ? 'confirmed' : 'pending') : 'waitlisted'

  try {
    await c.env.DB.prepare(
      "INSERT INTO participants (event_id, name, phone, email, user_id, status, ticket_type, spots, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).bind(event.id, name.trim(), phone?.trim() || '', email?.trim() || '', userId, status, ticketType, spots, notes?.trim() || null).run()
  } catch (err) {
    // UNIQUE constraint on (event_id, user_id) fired — concurrent duplicate.
    // The seat counter was already incremented above; undo it (by spots) so the cap stays accurate.
    if (err?.message?.includes('UNIQUE constraint failed')) {
      if (held) {
        await c.env.DB.prepare(
          'UPDATE events SET current_participants = MAX(0, current_participants - ?) WHERE id = ?'
        ).bind(spots, event.id).run().catch(() => {})
      }
      return c.json({ error: 'אתה כבר רשום לאירוע זה.' }, 409)
    }
    throw err
  }

  if (held) {
    if (isFree) {
      // Send confirmation email for free (instantly confirmed) registrations
      if (email?.trim() && event.confirmation_message) {
        sendBrevoEmail(c.env, {
          to: email.trim(),
          name: name.trim(),
          subject: `אישור הרשמה — ${event.title}`,
          htmlContent: buildConfirmationEmail(event, name.trim()),
        }).catch(() => {})
      }
      return c.json({ status: 'confirmed', message: 'נרשמת בהצלחה! המקום שלך מאושר.' }, 200)
    }
    return c.json({ status: 'pending', message: 'המקום שמור. יש לך 15 דקות לסיים את התשלום.' }, 200)
  }
  return c.json({ status: 'waitlisted', message: 'האירוע מלא. נוספת לרשימת ההמתנה.' }, 200)
})

// Cancel own registration. Releases the seat and promotes the first waiter if any.
app.delete('/events/:id/cancel-registration', authMiddleware, async c => {
  const userId = c.get('user').id
  const eventId = c.req.param('id')

  const participant = await c.env.DB.prepare(
    "SELECT id, status, spots FROM participants WHERE event_id = ? AND user_id = ? AND status != 'expired'"
  ).bind(eventId, userId).first()

  if (!participant) return c.json({ error: 'לא נמצאה הרשמה פעילה' }, 404)

  const canceledSpots = participant.spots || 1

  await c.env.DB.prepare('DELETE FROM participants WHERE id = ?').bind(participant.id).run()

  if (participant.status === 'confirmed' || participant.status === 'pending') {
    // Decrement by the number of spots the canceled booking held (1 or 2).
    await c.env.DB.prepare(
      'UPDATE events SET current_participants = MAX(0, current_participants - ?) WHERE id = ?'
    ).bind(canceledSpots, eventId).run()

    // Promote first waiter whose spots fit within the newly freed capacity.
    const waiter = await c.env.DB.prepare(
      "SELECT id, spots FROM participants WHERE event_id = ? AND status = 'waitlisted' ORDER BY created_at LIMIT 1"
    ).bind(eventId).first()

    if (waiter) {
      const waiterSpots = waiter.spots || 1
      const ev = await c.env.DB.prepare('SELECT price, couple_price, max_participants, current_participants FROM events WHERE id = ?').bind(eventId).first()
      const isFree = (waiterSpots > 1 ? (ev?.couple_price ?? 0) : (ev?.price ?? 0)) <= 0
      const promoted = await c.env.DB.prepare(
        `UPDATE events SET current_participants = current_participants + ?
          WHERE id = ? AND (max_participants = 0 OR current_participants + ? <= max_participants)
          RETURNING id`
      ).bind(waiterSpots, eventId, waiterSpots).first()
      if (promoted) {
        await c.env.DB.prepare("UPDATE participants SET status = ? WHERE id = ?")
          .bind(isFree ? 'confirmed' : 'pending', waiter.id).run()
      }
    }
  }

  return c.json({ message: 'ההרשמה בוטלה בהצלחה' })
})

// Confirm a pending hold once payment clears. Auth: admin JWT OR webhook secret.
// The seat was already counted at hold time, so confirming changes no counter.
app.post('/events/:id/confirm-payment', async c => {
  const auth = await isAdminOrWebhook(c)
  if (!auth.ok) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json().catch(() => ({}))
  const participantId = body.participant_id
  if (!participantId) return c.json({ error: 'participant_id is required' }, 400)

  // Only a still-pending hold for this event can be confirmed. An expired/invalid
  // hold (or wrong event) updates zero rows → 400.
  const updated = await c.env.DB.prepare(
    `UPDATE participants
        SET status = 'confirmed'
      WHERE id = ? AND event_id = ? AND status = 'pending'
      RETURNING id, name, email`
  ).bind(participantId, c.req.param('id')).first()

  if (!updated) return c.json({ error: 'Hold expired or invalid' }, 400)

  // Send confirmation email for paid registrations confirmed by admin
  if (updated.email) {
    const ev = await c.env.DB.prepare(
      'SELECT title, date, time, end_time, location, confirmation_message FROM events WHERE id = ?'
    ).bind(c.req.param('id')).first()
    if (ev?.confirmation_message) {
      sendBrevoEmail(c.env, {
        to: updated.email,
        name: updated.name,
        subject: `אישור הרשמה — ${ev.title}`,
        htmlContent: buildConfirmationEmail(ev, updated.name),
      }).catch(() => {})
    }
  }

  return c.json({ message: 'Payment confirmed', participant_id: updated.id }, 200)
})

// ── Admin events (/api/events) ────────────────────────────────────────────────

app.get('/events', authMiddleware, async c => {
  const { month, year } = c.req.query()
  let events

  if (month && year) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endMonth = parseInt(month) === 12 ? 1 : parseInt(month) + 1
    const endYear = parseInt(month) === 12 ? parseInt(year) + 1 : parseInt(year)
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`
    const { results } = await c.env.DB.prepare('SELECT * FROM events WHERE date >= ? AND date < ? ORDER BY date, time').bind(startDate, endDate).all()
    events = results
  } else {
    const { results } = await c.env.DB.prepare('SELECT * FROM events ORDER BY date, time').all()
    events = results
  }

  const enriched = await Promise.all(events.map(async e => {
    const { results: participants } = await c.env.DB.prepare(
      "SELECT * FROM participants WHERE event_id = ? AND status != 'expired' ORDER BY created_at"
    ).bind(e.id).all()
    return { ...e, participants, ...segmentCounts(participants) }
  }))
  return c.json(enriched)
})

app.get('/events/:id', authMiddleware, async c => {
  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first()
  if (!event) return c.json({ error: 'Event not found' }, 404)
  const { results: participants } = await c.env.DB.prepare(
    "SELECT * FROM participants WHERE event_id = ? AND status != 'expired' ORDER BY created_at"
  ).bind(event.id).all()
  return c.json({ ...event, participants, ...segmentCounts(participants) })
})

app.post('/events', authMiddleware, async c => {
  const { title, date, time, end_time, description, location, color, max_participants, price, allow_couples, couple_price, payment_link, confirmation_message, reminder_message } = await c.req.json()
  if (!title?.trim()) return c.json({ error: 'Title is required' }, 400)
  if (title.length > 255) return c.json({ error: 'Title must be less than 255 characters' }, 400)
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'Date required (YYYY-MM-DD)' }, 400)

  const result = await c.env.DB.prepare(
    'INSERT INTO events (title, date, time, end_time, description, location, color, max_participants, price, allow_couples, couple_price, payment_link, confirmation_message, reminder_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(title.trim(), date, time || '', end_time || '', description || '', location || '', color || '#3498db', max_participants || 0, ilsToAgorot(price), allow_couples ? 1 : 0, ilsToAgorot(couple_price), payment_link?.trim() || null, confirmation_message?.trim() || null, reminder_message?.trim() || null).run()

  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(result.meta.last_row_id).first()
  return c.json({ ...event, participants: [], participant_count: 0 }, 201)
})

app.put('/events/:id', authMiddleware, async c => {
  const existing = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first()
  if (!existing) return c.json({ error: 'Event not found' }, 404)

  const { title, date, time, end_time, description, location, color, max_participants, price, allow_couples, couple_price, payment_link, confirmation_message, reminder_message } = await c.req.json()
  await c.env.DB.prepare(
    'UPDATE events SET title=?, date=?, time=?, end_time=?, description=?, location=?, color=?, max_participants=?, price=?, allow_couples=?, couple_price=?, payment_link=?, confirmation_message=?, reminder_message=? WHERE id=?'
  ).bind(
    title !== undefined ? title.trim() : existing.title,
    date || existing.date,
    time !== undefined ? time : existing.time,
    end_time !== undefined ? end_time : existing.end_time,
    description !== undefined ? description : existing.description,
    location !== undefined ? location : existing.location,
    color || existing.color,
    max_participants !== undefined ? max_participants : existing.max_participants,
    price !== undefined ? ilsToAgorot(price) : existing.price,
    allow_couples !== undefined ? (allow_couples ? 1 : 0) : existing.allow_couples,
    couple_price !== undefined ? ilsToAgorot(couple_price) : existing.couple_price,
    payment_link !== undefined ? (payment_link?.trim() || null) : existing.payment_link,
    confirmation_message !== undefined ? (confirmation_message?.trim() || null) : existing.confirmation_message,
    reminder_message !== undefined ? (reminder_message?.trim() || null) : existing.reminder_message,
    c.req.param('id')
  ).run()

  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first()
  const { results: participants } = await c.env.DB.prepare('SELECT * FROM participants WHERE event_id = ?').bind(event.id).all()
  return c.json({ ...event, participants, participant_count: participants.length })
})

app.delete('/events/:id', authMiddleware, async c => {
  const existing = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first()
  if (!existing) return c.json({ error: 'Event not found' }, 404)
  await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ message: 'Event deleted successfully' })
})

app.delete('/events/:id/participants/:pid', authMiddleware, async c => {
  const participant = await c.env.DB.prepare('SELECT * FROM participants WHERE id = ? AND event_id = ?').bind(c.req.param('pid'), c.req.param('id')).first()
  if (!participant) return c.json({ error: 'Participant not found' }, 404)
  await c.env.DB.prepare('DELETE FROM participants WHERE id = ?').bind(c.req.param('pid')).run()
  return c.json({ message: 'Participant removed' })
})

// ── 24h Reminder Cron (/api/internal/send-reminders) ─────────────────────────
// Called daily by GitHub Actions. Sends reminder emails to all confirmed
// participants of events happening tomorrow that haven't been reminded yet.
app.post('/internal/send-reminders', async c => {
  const cronSecret = c.env.CRON_SECRET
  const auth = c.req.header('Authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) return c.json({ error: 'Forbidden' }, 403)

  // Events happening tomorrow (server time = UTC; adjust if needed)
  const { results: events } = await c.env.DB.prepare(
    "SELECT id, title, date, time, end_time, location, reminder_message FROM events WHERE date = date('now', '+1 day') AND reminder_message IS NOT NULL AND reminder_message != ''"
  ).all()

  if (!events.length) return c.json({ reminded: 0 })

  let reminded = 0
  for (const ev of events) {
    const { results: participants } = await c.env.DB.prepare(
      "SELECT id, name, email FROM participants WHERE event_id = ? AND status = 'confirmed' AND reminder_sent = 0 AND email != ''"
    ).bind(ev.id).all()

    for (const p of participants) {
      await sendBrevoEmail(c.env, {
        to: p.email,
        name: p.name,
        subject: `תזכורת — ${ev.title} מחר`,
        htmlContent: buildReminderEmail(ev, p.name),
      }).catch(() => {})
      await c.env.DB.prepare('UPDATE participants SET reminder_sent = 1 WHERE id = ?').bind(p.id).run()
      reminded++
    }
  }

  return c.json({ reminded })
})

export function onRequest(context) {
  return app.fetch(context.request, context.env, context)
}
