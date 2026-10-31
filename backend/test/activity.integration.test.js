require('dotenv').config({ quiet: true });

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');
const Resource = require('../models/Resource');
const User = require('../models/User');
const { app } = require('../server');

describe('Commonroom activity API', { concurrency: false }, () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const userIds = [];
  const resourceIds = [];
  const bookingIds = [];
  const activityIds = [];
  let owner;
  let otherOwner;
  let borrower;
  let outsider;
  let admin;
  let resourceId;
  let bookingId;
  let server;
  let baseUrl;
  let userCounter = 0;

  async function createUser(role) {
    const user = await User.create({
      name: `Activity Test ${role}`,
      email: `activity-${role}-${suffix}-${++userCounter}@example.invalid`,
      password: await bcrypt.hash('ActivityTest-123!', 4),
      role
    });
    userIds.push(user._id);
    return { id: user._id.toString(), token: jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) };
  }

  async function activity(actor, action, related = {}) {
    const item = await Activity.create({
      user: actor.id,
      action,
      relatedResource: related.resource ?? null,
      relatedBooking: related.booking ?? null,
      details: { visible: action, note: 'Bearer example.abc.def password=leakedvalue', eventTimestamp: new Date('2026-01-02T03:04:05.000Z'), password: 'must-not-be-returned', nested: { accessToken: 'must-not-be-returned-either' } }
    });
    activityIds.push(item._id);
    return item;
  }

  function get(path, actor) {
    return fetch(`${baseUrl}${path}`, { headers: actor ? { authorization: `Bearer ${actor.token}` } : {} });
  }

  before(async () => {
    assert.ok(process.env.JWT_SECRET && Buffer.byteLength(process.env.JWT_SECRET, 'utf8') >= 32,
      'Set JWT_SECRET in backend/.env before running activity tests.');
    await connectDB();
    await Promise.all([User.init(), Resource.init(), Booking.init(), Activity.init()]);
    [owner, otherOwner, borrower, outsider, admin] = await Promise.all([
      createUser('owner'), createUser('owner'), createUser('member'), createUser('member'), createUser('admin')
    ]);
    const resource = await Resource.create({ name: `Activity Resource ${suffix}`, description: 'Test resource.', category: 'Tools', location: 'Lab', owner: owner.id });
    resourceId = resource._id.toString();
    resourceIds.push(resource._id);
    const booking = await Booking.create({
      resource: resource._id, borrower: borrower.id,
      startDate: new Date(Date.now() + 86400000), endDate: new Date(Date.now() + 90000000),
      purpose: 'Activity access test'
    });
    bookingId = booking._id.toString();
    bookingIds.push(booking._id);
    await activity(borrower, 'activity_test_borrower', { resource: resource._id, booking: booking._id });
    await activity(borrower, 'activity_test_borrower_second', { resource: resource._id, booking: booking._id });
    await activity(outsider, 'activity_test_private');

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (activityIds.length) await Activity.deleteMany({ _id: { $in: activityIds } });
    if (bookingIds.length) await Booking.deleteMany({ _id: { $in: bookingIds } });
    if (resourceIds.length) await Resource.deleteMany({ _id: { $in: resourceIds } });
    if (userIds.length) await User.deleteMany({ _id: { $in: userIds } });
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    await mongoose.disconnect();
  });

  it('restricts personal activity to its authenticated user and sanitizes sensitive detail keys', async () => {
    const own = await get('/api/activity/my', borrower);
    assert.equal(own.status, 200);
    const ownBody = await own.json();
    assert.equal(ownBody.success, true);
    assert.ok(ownBody.data.length >= 2);
    assert.ok(ownBody.data.every(item => item.user._id === borrower.id));
    const serialized = JSON.stringify(ownBody.data);
    assert.ok(!serialized.includes('must-not-be-returned'));
    assert.ok(!serialized.includes('example.abc.def'));
    assert.ok(!serialized.includes('leakedvalue'));
    assert.ok(ownBody.data.every(item => !('password' in item.details)));
    assert.equal(ownBody.data[0].details.eventTimestamp, '2026-01-02T03:04:05.000Z');
    const outsiderList = await (await get('/api/activity/my', outsider)).json();
    assert.ok(outsiderList.data.every(item => item.user._id === outsider.id));
    assert.equal((await get('/api/activity/my')).status, 401);
  });

  it('allows resource owner and admin to view resource history, but denies other owners', async () => {
    const own = await get(`/api/activity/resource/${resourceId}`, owner);
    assert.equal(own.status, 200);
    assert.ok((await own.json()).data.length >= 2);
    assert.equal((await get(`/api/activity/resource/${resourceId}`, otherOwner)).status, 403);
    assert.equal((await get(`/api/activity/resource/${resourceId}`, borrower)).status, 403);
    assert.equal((await get('/api/activity/resource/invalid', owner)).status, 400);
    assert.equal((await get('/api/activity/resource/not-found', admin)).status, 400);
    assert.equal((await get(`/api/activity/resource/${new mongoose.Types.ObjectId()}`, admin)).status, 404);
  });

  it('allows the borrower, resource owner, or admin to view booking activity only', async () => {
    assert.equal((await get(`/api/activity/booking/${bookingId}`, borrower)).status, 200);
    assert.equal((await get(`/api/activity/booking/${bookingId}`, owner)).status, 200);
    assert.equal((await get(`/api/activity/booking/${bookingId}`, outsider)).status, 403);
    assert.equal((await get(`/api/activity/booking/${bookingId}`, admin)).status, 200);
    assert.equal((await get('/api/activity/booking/invalid', borrower)).status, 400);
    assert.equal((await get(`/api/activity/booking/${new mongoose.Types.ObjectId()}`, borrower)).status, 404);
  });

  it('makes the global activity list admin-only', async () => {
    assert.equal((await get('/api/activity', borrower)).status, 403);
    const response = await get('/api/activity', admin);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).data.length >= 3);
  });

  it('supports pagination, action and date filters with newest-first order', async () => {
    const from = new Date(Date.now() - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const response = await get(`/api/activity/my?limit=1&action=activity_test_borrower&startDate=${encodeURIComponent(from)}`, borrower);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.pagination.limit, 1);
    assert.equal(body.pagination.total, 1);
    assert.equal(body.data[0].action, 'activity_test_borrower');
    const invalid = await get('/api/activity/my?startDate=not-a-date', borrower);
    assert.equal(invalid.status, 400);
    assert.equal((await get('/api/activity/my?startDate=2026-02-30', borrower)).status, 400);
    const reversed = await get('/api/activity/my?startDate=2030-01-02&endDate=2030-01-01', borrower);
    assert.equal(reversed.status, 400);
  });

  it('exposes no public activity create, update, or delete endpoints', async () => {
    const headers = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' };
    const url = `${baseUrl}/api/activity`;
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(url, { method: 'PATCH', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 404);
  });
});
