const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

const validRoles = new Set(['member', 'owner', 'manager', 'admin']);

async function authenticateToken(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) return res.status(401).json({ success: false, error: 'Authentication required.' });

  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    return res.status(500).json({ success: false, error: 'Authentication is not configured.' });
  }

  let payload;
  try {
    payload = jwt.verify(match[1], secret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }

  if (!payload || typeof payload.sub !== 'string' || !mongoose.isValidObjectId(payload.sub)) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }

  try {
    const user = await User.findById(payload.sub).select('_id name email role createdAt');
    if (!user) return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

function optionalAuthenticateToken(req, res, next) {
  if (!req.get('authorization')) return next();
  return authenticateToken(req, res, next);
}

function authorizeRoles(...roles) {
  const allowedRoles = roles.flat();
  if (!allowedRoles.length || allowedRoles.some(role => !validRoles.has(role))) {
    throw new TypeError('authorizeRoles requires one or more valid roles.');
  }

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'You do not have permission to access this resource.' });
    }
    return next();
  };
}

module.exports = { authenticateToken, optionalAuthenticateToken, authorizeRoles };
