const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { generateToken, authenticateToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/user-auth/register
router.post('/register', (req, res) => {
  const { name, email, phone, password } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), email.trim().toLowerCase(), phone?.trim() || '', hash);

  const user = { id: result.lastInsertRowid, name: name.trim(), email: email.trim().toLowerCase() };
  const token = generateToken(user, 'user');

  res.status(201).json({
    user: { id: user.id, name: user.name, email: user.email, phone: phone?.trim() || '' },
    token
  });
});

// POST /api/user-auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = generateToken({ id: user.id, email: user.email, name: user.name }, 'user');
  res.json({
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
    token
  });
});

// GET /api/user-auth/me
router.get('/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

module.exports = router;
