const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { generateToken, authenticateToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login (admin only)
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = generateToken({ id: admin.id, email: admin.email, name: admin.name }, 'admin');
  res.json({ user: { id: admin.id, name: admin.name, email: admin.email }, token });
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  const admin = db.prepare('SELECT id, name, email FROM admins WHERE id = ?').get(req.user.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  res.json(admin);
});

module.exports = router;
