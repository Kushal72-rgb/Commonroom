const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');

async function provisionDemoOwner() {
  if (process.env.ALLOW_LOCAL_OWNER_PROVISIONING !== 'true') {
    throw new Error('Local owner provisioning requires explicit opt-in.');
  }

  let parsedUri;
  try {
    parsedUri = new URL(process.env.MONGODB_URI);
  } catch {
    throw new Error('MONGODB_URI is invalid.');
  }
  if (parsedUri.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(parsedUri.hostname) || parsedUri.pathname !== '/commonroom') {
    throw new Error('Demo owner provisioning is restricted to the local commonroom database.');
  }

  const name = process.env.DEMO_OWNER_NAME?.trim();
  const email = process.env.DEMO_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.DEMO_OWNER_PASSWORD;
  if (!name || name.length > 120 || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid demo owner name and email are required.');
  }
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('The demo owner password must be at least 8 characters and no more than 72 UTF-8 bytes.');
  }

  await connectDB();
  const existing = await User.findOne({ email }).select('_id');
  if (existing) throw new Error('An account with that email already exists.');

  const hashedPassword = await bcrypt.hash(password, 12);
  await User.create({ name, email, password: hashedPassword, role: 'owner' });
  console.log('Local demo owner created. No password or token was displayed.');
}

provisionDemoOwner()
  .catch(() => {
    console.error('Could not provision the local demo owner. Check the local database, input values, and opt-in setting.');
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
