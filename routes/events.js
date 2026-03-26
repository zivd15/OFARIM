const express = require('express');
const { db } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// ─── PUBLIC ROUTES (no auth) ─────────────────────────────

// GET /api/events/public?month=3&year=2026
router.get('/public', (req, res) => {
  const { month, year } = req.query;

  let events;
  if (month && year) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = parseInt(month) === 12 ? 1 : parseInt(month) + 1;
    const endYear = parseInt(month) === 12 ? parseInt(year) + 1 : parseInt(year);
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
    events = db.prepare(
      'SELECT id, title, date, time, end_time, description, location, color, max_participants FROM events WHERE date >= ? AND date < ? ORDER BY date, time'
    ).all(startDate, endDate);
  } else {
    events = db.prepare(
      'SELECT id, title, date, time, end_time, description, location, color, max_participants FROM events ORDER BY date, time'
    ).all();
  }

  // Add participant count to each event
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM participants WHERE event_id = ?');
  events = events.map(e => ({
    ...e,
    participant_count: countStmt.get(e.id).count,
    spots_left: e.max_participants > 0 ? Math.max(0, e.max_participants - countStmt.get(e.id).count) : null,
  }));

  res.json(events);
});

// POST /api/events/:id/register (public sign up)
router.post('/:id/register', (req, res) => {
  const { name, phone, email } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Check max participants
  if (event.max_participants > 0) {
    const count = db.prepare('SELECT COUNT(*) as count FROM participants WHERE event_id = ?').get(event.id).count;
    if (count >= event.max_participants) {
      return res.status(400).json({ error: 'Event is full' });
    }
  }

  // Check for duplicate registration (same name + phone for same event)
  if (phone) {
    const existing = db.prepare(
      'SELECT id FROM participants WHERE event_id = ? AND name = ? AND phone = ?'
    ).get(event.id, name.trim(), phone.trim());
    if (existing) {
      return res.status(409).json({ error: 'You are already registered for this event' });
    }
  }

  const result = db.prepare(
    'INSERT INTO participants (event_id, name, phone, email) VALUES (?, ?, ?, ?)'
  ).run(event.id, name.trim(), phone?.trim() || '', email?.trim() || '');

  const count = db.prepare('SELECT COUNT(*) as count FROM participants WHERE event_id = ?').get(event.id).count;

  res.status(201).json({
    message: 'Registered successfully',
    participant_count: count,
    spots_left: event.max_participants > 0 ? Math.max(0, event.max_participants - count) : null,
  });
});

// ─── ADMIN ROUTES (auth required) ────────────────────────

// GET /api/events (admin - all events with full participant list)
router.get('/', authenticateToken, (req, res) => {
  const { month, year } = req.query;

  let events;
  if (month && year) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endMonth = parseInt(month) === 12 ? 1 : parseInt(month) + 1;
    const endYear = parseInt(month) === 12 ? parseInt(year) + 1 : parseInt(year);
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
    events = db.prepare('SELECT * FROM events WHERE date >= ? AND date < ? ORDER BY date, time').all(startDate, endDate);
  } else {
    events = db.prepare('SELECT * FROM events ORDER BY date, time').all();
  }

  const participantStmt = db.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY signed_at');
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM participants WHERE event_id = ?');

  events = events.map(e => ({
    ...e,
    participants: participantStmt.all(e.id),
    participant_count: countStmt.get(e.id).count,
  }));

  res.json(events);
});

// GET /api/events/:id (admin)
router.get('/:id', authenticateToken, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  event.participants = db.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY signed_at').all(event.id);
  event.participant_count = event.participants.length;

  res.json(event);
});

// POST /api/events (admin create)
router.post('/', authenticateToken, (req, res) => {
  const { title, date, time, end_time, description, location, color, max_participants } = req.body;

  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  if (title.length > 255) return res.status(400).json({ error: 'Title must be less than 255 characters' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date required (YYYY-MM-DD)' });

  const result = db.prepare(
    'INSERT INTO events (title, date, time, end_time, description, location, color, max_participants) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    title.trim(), date, time || '', end_time || '',
    description || '', location || '', color || '#3498db',
    max_participants || 0
  );

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid);
  event.participants = [];
  event.participant_count = 0;
  res.status(201).json(event);
});

// PUT /api/events/:id (admin update)
router.put('/:id', authenticateToken, (req, res) => {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });

  const { title, date, time, end_time, description, location, color, max_participants } = req.body;

  db.prepare(
    'UPDATE events SET title=?, date=?, time=?, end_time=?, description=?, location=?, color=?, max_participants=? WHERE id=?'
  ).run(
    title !== undefined ? title.trim() : existing.title,
    date || existing.date,
    time !== undefined ? time : existing.time,
    end_time !== undefined ? end_time : existing.end_time,
    description !== undefined ? description : existing.description,
    location !== undefined ? location : existing.location,
    color || existing.color,
    max_participants !== undefined ? max_participants : existing.max_participants,
    req.params.id
  );

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  event.participants = db.prepare('SELECT * FROM participants WHERE event_id = ?').all(event.id);
  event.participant_count = event.participants.length;
  res.json(event);
});

// DELETE /api/events/:id (admin)
router.delete('/:id', authenticateToken, (req, res) => {
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ message: 'Event deleted successfully' });
});

// DELETE /api/events/:id/participants/:pid (admin remove participant)
router.delete('/:id/participants/:pid', authenticateToken, (req, res) => {
  const participant = db.prepare('SELECT * FROM participants WHERE id = ? AND event_id = ?').get(req.params.pid, req.params.id);
  if (!participant) return res.status(404).json({ error: 'Participant not found' });
  db.prepare('DELETE FROM participants WHERE id = ?').run(req.params.pid);
  res.json({ message: 'Participant removed' });
});

module.exports = router;
