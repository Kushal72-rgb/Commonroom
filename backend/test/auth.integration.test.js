require('dotenv').config({ quiet: true });

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const { app } = require('../server');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const { createAuthRateLimit } = require('../middleware/authRateLimit');

describe('Commonroom authentication API', { concurrency: false }, () => {
  const email = `auth-test-${new mongoose.Types.ObjectId().toString()}@example.invalid`;
  const password = 'DemoPassword-329!';
  let apiServer;
  let roleServer;
  let baseUrl;
  let roleUrl;
  let token;
  let userId;

  before(async () => {
    assert.ok(process.env.JWT_SECRET && Buffer.byteLength(process.env.JWT_SECRET, 'utf8') >= 32,
      'Set a JWT_SECRET in backend/.env before running the auth tests.');
    await connectDB();
    await User.init();

    const roleApp = express();
    roleApp.get('/owner-only', authenticateToken, authorizeRoles('owner', 'manager', 'admin'), (req, res) => {
      res.sendStatus(204);
    });
    apiServer = app.listen(0, '127.0.0.1');
    roleServer = roleApp.listen(0, '127.0.0.1');
    await Promise.all([
      new Promise(resolve => apiServer.once('listening', resolve)),
      new Promise(resolve => roleServer.once('listening', resolve))
    ]);
    baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
    roleUrl = `http://127.0.0.1:${roleServer.address().port}`;
  });

  after(async () => {
    if (email) await User.deleteOne({ email });
    for (const server of [apiServer, roleServer]) {
      if (!server) continue;
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    await mongoose.disconnect();
  });

  it('registers a member, hashes the password, and ignores a supplied admin role', async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test Member', email, password, role: 'admin' })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.user.role, 'member');
    assert.ok(body.token);
    assert.equal(Object.hasOwn(body.user, 'password'), false);
    token = body.token;
    userId = body.user.id;

    const storedUser = await User.findById(userId).select('+password');
    assert.notEqual(storedUser.password, password);
    assert.equal(await bcrypt.compare(password, storedUser.password), true);
  });

  it('rejects duplicate email registration with 409', async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate', email: email.toUpperCase(), password })
    });
    assert.equal(response.status, 409);
  });

  it('validates registration input', async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ' ', email: 'not-an-email', password: 'short' })
    });
    assert.equal(response.status, 400);
  });

  it('logs in with the correct password without returning the hash', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.user.id, userId);
    assert.ok(body.token);
    assert.equal(Object.hasOwn(body.user, 'password'), false);
  });

  it('rejects an incorrect password with a generic 401 response', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'WrongPassword-123!' })
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'Invalid email or password.');
  });

  it('rejects missing and invalid tokens on /me', async () => {
    const missing = await fetch(`${baseUrl}/api/auth/me`);
    const invalid = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: 'Bearer not-a-valid-token' } });
    const expiredToken = jwt.sign({ sub: userId }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: -1 });
    const expired = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${expiredToken}` } });
    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
    assert.equal(expired.status, 401);
  });

  it('returns the safe profile for a valid token', async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.user.id, userId);
    assert.equal(body.user.email, email);
    assert.equal(Object.hasOwn(body.user, 'password'), false);
  });

  it('enforces allowed roles and reads the current role from MongoDB', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const memberResponse = await fetch(`${roleUrl}/owner-only`, { headers });
    assert.equal(memberResponse.status, 403);

    for (const role of ['owner', 'manager', 'admin']) {
      await User.updateOne({ _id: userId }, { $set: { role } });
      const privilegedResponse = await fetch(`${roleUrl}/owner-only`, { headers });
      assert.equal(privilegedResponse.status, 204, `${role} should pass the role guard`);
    }

    await User.updateOne({ _id: userId }, { $set: { role: 'member' } });
  });

  it('limits repeated authentication attempts and provides a retry delay', () => {
    let now = 1000;
    const limiter = createAuthRateLimit({ windowMs: 10000, max: 2, now: () => now });
    const request = { ip: '127.0.0.1', baseUrl: '/api/auth', path: '/login' };
    const response = () => ({
      headers: {}, statusCode: 200, body: null,
      set(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    });
    let nextCount = 0;
    limiter(request, response(), () => { nextCount += 1; });
    limiter(request, response(), () => { nextCount += 1; });
    const blocked = response();
    limiter(request, blocked, () => { nextCount += 1; });
    assert.equal(nextCount, 2);
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['Retry-After']) > 0);
    now += 10001;
    limiter(request, response(), () => { nextCount += 1; });
    assert.equal(nextCount, 3);
  });
});
