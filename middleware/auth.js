const jwt = require('jsonwebtoken');

const JWT_SECRET = 'ofarim-secret-key-2024';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function generateToken(user, role = 'user') {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) {}
  }
  next();
}

module.exports = { authenticateToken, generateToken, optionalAuth, JWT_SECRET };
