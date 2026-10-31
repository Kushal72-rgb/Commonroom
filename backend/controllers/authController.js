const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const bcryptMaxBytes = 72;

function publicProfile(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

function createToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes.');
  }

  return jwt.sign(
    { sub: user._id.toString() },
    secret,
    { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
  );
}

function validateCredentials({ name, email, password }, includeName = false) {
  if (includeName && (typeof name !== 'string' || !name.trim() || name.trim().length > 120)) {
    return 'Name is required and must be at most 120 characters.';
  }
  if (typeof email !== 'string' || !emailPattern.test(email.trim()) || email.trim().length > 254) {
    return 'A valid email address is required.';
  }
  if (typeof password !== 'string' || !password.length) {
    return 'Password is required.';
  }
  if (includeName && password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (Buffer.byteLength(password, 'utf8') > bcryptMaxBytes) {
    return 'Password must be no more than 72 UTF-8 bytes.';
  }
  return null;
}

async function register(req, res, next) {
  const input = req.body || {};
  const validationError = validateCredentials(input, true);
  if (validationError) return res.status(400).json({ error: validationError });

  const email = input.email.trim().toLowerCase();
  try {
    const existingUser = await User.findOne({ email }).select('_id');
    if (existingUser) return res.status(409).json({ error: 'An account with this email already exists.' });

    const hashedPassword = await bcrypt.hash(input.password, 12);
    const user = await User.create({
      name: input.name.trim(),
      email,
      password: hashedPassword,
      // Public registration never accepts a client-selected role.
      role: 'member'
    });

    return res.status(201).json({ user: publicProfile(user), token: createToken(user) });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    return next(err);
  }
}

async function login(req, res, next) {
  const input = req.body || {};
  const validationError = validateCredentials(input);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const email = input.email.trim().toLowerCase();
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await bcrypt.compare(input.password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    return res.status(200).json({ user: publicProfile(user), token: createToken(user) });
  } catch (err) {
    return next(err);
  }
}

function getMe(req, res) {
  return res.status(200).json({ user: publicProfile(req.user) });
}

module.exports = { register, login, getMe, publicProfile };
