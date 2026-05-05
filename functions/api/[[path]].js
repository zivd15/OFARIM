import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono().basePath('/api')

app.use('*', cors())

// ── JWT ──────────────────────────────────────────────────────────────────────

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
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
  return env.JWT_SECRET || 'ofarim-secret-key-2024'
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
  const token = c.req.header('authorization')?.split(' ')[1]
  if (!token) return c.json({ error: 'Authentication required' }, 401)
  try {
    c.set('user', await verifyJWT(token, jwtSecret(c.env)))
    await next()
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 403)
  }
}

async function optionalAuthMiddleware(c, next) {
  const token = c.req.header('authorization')?.split(' ')[1]
  if (token) {
    try { c.set('user', await verifyJWT(token, jwtSecret(c.env))) } catch {}
  }
  await next()
}

// ── Startup: ensure default admin exists ─────────────────────────────────────

async function ensureAdmin(db, secret) {
  const row = await db.prepare('SELECT COUNT(*) as count FROM admins').first()
  if (row.count === 0) {
    const hash = await hashPassword('admin123')
    await db.prepare('INSERT INTO admins (name, email, password) VALUES (?, ?, ?)')
      .bind('Admin', 'admin@ofarim.com', hash).run()
  }
}

// ── Admin auth (/api/auth/*) ──────────────────────────────────────────────────

app.post('/auth/login', async c => {
  const { email, password } = await c.req.json()
  if (!email || !password) return c.json({ error: 'Email and password are required' }, 400)

  await ensureAdmin(c.env.DB, jwtSecret(c.env))

  const admin = await c.env.DB.prepare('SELECT * FROM admins WHERE email = ?').bind(email).first()
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

// ── User auth (/api/user-auth/*) ──────────────────────────────────────────────

app.post('/user-auth/register', async c => {
  const { name, email, phone, password } = await c.req.json()
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!email?.trim()) return c.json({ error: 'Email is required' }, 400)
  if (!password || password.length < 6) return c.json({ error: 'Password must be at least 6 characters' }, 400)

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first()
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const hash = await hashPassword(password)
  const result = await c.env.DB.prepare(
    'INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)'
  ).bind(name.trim(), email.trim().toLowerCase(), phone?.trim() || '', hash).run()

  const user = { id: result.meta.last_row_id, name: name.trim(), email: email.trim().toLowerCase() }
  const token = await generateToken(user, 'user', jwtSecret(c.env))
  return c.json({ user: { ...user, phone: phone?.trim() || '' }, token }, 201)
})

app.post('/user-auth/login', async c => {
  const { email, password } = await c.req.json()
  if (!email || !password) return c.json({ error: 'Email and password are required' }, 400)

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first()
  if (!user || !(await verifyPassword(password, user.password))) {
    return c.json({ error: 'Invalid email or password' }, 401)
  }
  const token = await generateToken({ id: user.id, email: user.email, name: user.name }, 'user', jwtSecret(c.env))
  return c.json({ user: { id: user.id, name: user.name, email: user.email, phone: user.phone }, token })
})

app.get('/user-auth/me', authMiddleware, async c => {
  const user = await c.env.DB.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').bind(c.get('user').id).first()
  if (!user) return c.json({ error: 'User not found' }, 404)
  return c.json(user)
})

// ── Event helper ──────────────────────────────────────────────────────────────

async function withCounts(db, event) {
  const row = await db.prepare('SELECT COUNT(*) as count FROM participants WHERE event_id = ?').bind(event.id).first()
  return {
    ...event,
    participant_count: row.count,
    spots_left: event.max_participants > 0 ? Math.max(0, event.max_participants - row.count) : null,
  }
}

// ── Public events (/api/events/public, /api/events/my-events, /:id/*) ────────

app.get('/events/public', async c => {
  const { month, year } = c.req.query()
  let events

  if (month && year) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endMonth = parseInt(month) === 12 ? 1 : parseInt(month) + 1
    const endYear = parseInt(month) === 12 ? parseInt(year) + 1 : parseInt(year)
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`
    const { results } = await c.env.DB.prepare(
      'SELECT id, title, date, time, end_time, description, location, color, max_participants FROM events WHERE date >= ? AND date < ? ORDER BY date, time'
    ).bind(startDate, endDate).all()
    events = results
  } else {
    const { results } = await c.env.DB.prepare(
      'SELECT id, title, date, time, end_time, description, location, color, max_participants FROM events ORDER BY date, time'
    ).all()
    events = results
  }

  return c.json(await Promise.all(events.map(e => withCounts(c.env.DB, e))))
})

app.get('/events/my-events', authMiddleware, async c => {
  const { results: events } = await c.env.DB.prepare(`
    SELECT e.*, p.signed_at as registered_at, p.id as participant_id
    FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE p.user_id = ?
    ORDER BY e.date DESC, e.time DESC
  `).bind(c.get('user').id).all()

  return c.json(await Promise.all(events.map(e => withCounts(c.env.DB, e))))
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
  const { name, phone, email } = await c.req.json()
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)

  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first()
  if (!event) return c.json({ error: 'Event not found' }, 404)

  if (event.max_participants > 0) {
    const row = await c.env.DB.prepare('SELECT COUNT(*) as count FROM participants WHERE event_id = ?').bind(event.id).first()
    if (row.count >= event.max_participants) return c.json({ error: 'Event is full' }, 400)
  }

  const reqUser = c.get('user')
  if (reqUser) {
    const dup = await c.env.DB.prepare('SELECT id FROM participants WHERE event_id = ? AND user_id = ?').bind(event.id, reqUser.id).first()
    if (dup) return c.json({ error: 'You are already registered for this event' }, 409)
  } else if (phone) {
    const dup = await c.env.DB.prepare('SELECT id FROM participants WHERE event_id = ? AND name = ? AND phone = ?').bind(event.id, name.trim(), phone.trim()).first()
    if (dup) return c.json({ error: 'You are already registered for this event' }, 409)
  }

  await c.env.DB.prepare('INSERT INTO participants (event_id, name, phone, email, user_id) VALUES (?, ?, ?, ?, ?)')
    .bind(event.id, name.trim(), phone?.trim() || '', email?.trim() || '', reqUser?.id ?? null).run()

  const row = await c.env.DB.prepare('SELECT COUNT(*) as count FROM participants WHERE event_id = ?').bind(event.id).first()
  return c.json({
    message: 'Registered successfully',
    participant_count: row.count,
    spots_left: event.max_participants > 0 ? Math.max(0, event.max_participants - row.count) : null,
  }, 201)
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
    const { results: participants } = await c.env.DB.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY signed_at').bind(e.id).all()
    return { ...e, participants, participant_count: participants.length }
  }))
  return c.json(enriched)
})

app.get('/events/:id', authMiddleware, async c => {
  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first()
  if (!event) return c.json({ error: 'Event not found' }, 404)
  const { results: participants } = await c.env.DB.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY signed_at').bind(event.id).all()
  return c.json({ ...event, participants, participant_count: participants.length })
})

app.post('/events', authMiddleware, async c => {
  const { title, date, time, end_time, description, location, color, max_participants } = await c.req.json()
  if (!title?.trim()) return c.json({ error: 'Title is required' }, 400)
  if (title.length > 255) return c.json({ error: 'Title must be less than 255 characters' }, 400)
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'Date required (YYYY-MM-DD)' }, 400)

  const result = await c.env.DB.prepare(
    'INSERT INTO events (title, date, time, end_time, description, location, color, max_participants) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(title.trim(), date, time || '', end_time || '', description || '', location || '', color || '#3498db', max_participants || 0).run()

  const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(result.meta.last_row_id).first()
  return c.json({ ...event, participants: [], participant_count: 0 }, 201)
})

app.put('/events/:id', authMiddleware, async c => {
  const existing = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(c.req.param('id')).first()
  if (!existing) return c.json({ error: 'Event not found' }, 404)

  const { title, date, time, end_time, description, location, color, max_participants } = await c.req.json()
  await c.env.DB.prepare(
    'UPDATE events SET title=?, date=?, time=?, end_time=?, description=?, location=?, color=?, max_participants=? WHERE id=?'
  ).bind(
    title !== undefined ? title.trim() : existing.title,
    date || existing.date,
    time !== undefined ? time : existing.time,
    end_time !== undefined ? end_time : existing.end_time,
    description !== undefined ? description : existing.description,
    location !== undefined ? location : existing.location,
    color || existing.color,
    max_participants !== undefined ? max_participants : existing.max_participants,
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

export function onRequest(context) {
  return app.fetch(context.request, context.env, context)
}
