require('dotenv').config({ quiet: true });

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');
const Incident = require('../models/Incident');
const Resource = require('../models/Resource');
const User = require('../models/User');
const { app } = require('../server');

describe('Commonroom incident API', { concurrency: false }, () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const userIds = [];
  const resourceIds = [];
  const bookingIds = [];
  const incidentIds = [];
  let owner;
  let otherOwner;
  let borrower;
  let otherBorrower;
  let admin;
  let resourceId;
  let bookingId;
  let server;
  let baseUrl;
  let userCounter = 0;
  const password = 'IncidentTest-123!';

  async function createUser(role) {
    const user = await User.create({
      name: `Incident Test ${role}`,
      email: `incident-${role}-${suffix}-${++userCounter}@example.invalid`,
      password: await bcrypt.hash(password, 4),
      role
    });
    userIds.push(user._id);
    return {
      id: user._id.toString(),
      token: jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
    };
  }

  async function report(actor, body) {
    const response = await fetch(`${baseUrl}/api/incidents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (response.status === 201 && result.data?._id) incidentIds.push(result.data._id);
    return { response, result };
  }

  async function patch(actor, id, action, body) {
    return fetch(`${baseUrl}/api/incidents/${id}/${action}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  async function createReport(description = `A distinct issue ${new mongoose.Types.ObjectId()}`) {
    const result = await report(borrower, { booking: bookingId, description });
    assert.equal(result.response.status, 201);
    return result.result.data._id;
  }

  before(async () => {
    assert.ok(process.env.JWT_SECRET && Buffer.byteLength(process.env.JWT_SECRET, 'utf8') >= 32,
      'Set JWT_SECRET in backend/.env before running incident tests.');
    await connectDB();
    await Promise.all([User.init(), Resource.init(), Booking.init(), Incident.init(), Activity.init()]);
    [owner, otherOwner, borrower, otherBorrower, admin] = await Promise.all([
      createUser('owner'), createUser('owner'), createUser('member'), createUser('member'), createUser('admin')
    ]);
    const resource = await Resource.create({
      name: `Incident Test Resource ${suffix}`,
      description: 'Fictional integration test resource.',
      category: 'Equipment', location: 'Test area', owner: owner.id, status: 'active'
    });
    resourceId = resource._id.toString();
    resourceIds.push(resource._id);
    const booking = await Booking.create({
      resource: resource._id, borrower: borrower.id,
      startDate: new Date(Date.now() + 86400000), endDate: new Date(Date.now() + 90000000),
      purpose: `Incident test ${suffix}`, status: 'in_use'
    });
    bookingId = booking._id.toString();
    bookingIds.push(booking._id);

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await Activity.deleteMany({ $or: [
      { relatedBooking: { $in: bookingIds } },
      { relatedIncident: { $in: incidentIds } },
      { relatedResource: { $in: resourceIds } }
    ] });
    if (incidentIds.length) await Incident.deleteMany({ _id: { $in: incidentIds } });
    if (bookingIds.length) await Booking.deleteMany({ _id: { $in: bookingIds } });
    if (resourceIds.length) await Resource.deleteMany({ _id: { $in: resourceIds } });
    if (userIds.length) await User.deleteMany({ _id: { $in: userIds } });
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    await mongoose.disconnect();
  });

  it('creates an incident from the authenticated borrower and records activity', async () => {
    const result = await report(borrower, { booking: bookingId, description: 'The equipment casing is cracked.' });
    assert.equal(result.response.status, 201);
    assert.equal(result.result.data.reportedBy, borrower.id);
    assert.equal(result.result.data.status, 'open');
    const activity = await Activity.findOne({ relatedIncident: result.result.data._id, action: 'incident_reported' });
    assert.ok(activity);
    assert.equal(activity.user.toString(), borrower.id);
    assert.equal(activity.relatedBooking.toString(), bookingId);
    assert.equal(activity.relatedResource.toString(), resourceId);
  });

  it('validates booking IDs, existence, borrower ownership, body fields, and description', async () => {
    assert.equal((await report(borrower, { booking: 'invalid', description: 'A sufficiently clear report.' })).response.status, 400);
    assert.equal((await report(borrower, { booking: new mongoose.Types.ObjectId(), description: 'A sufficiently clear report.' })).response.status, 404);
    assert.equal((await report(otherBorrower, { booking: bookingId, description: 'A sufficiently clear report.' })).response.status, 403);
    assert.equal((await report(borrower, { booking: bookingId, reportedBy: admin.id, description: 'A sufficiently clear report.' })).response.status, 400);
    assert.equal((await report(borrower, { booking: bookingId, description: '  ' })).response.status, 400);
    assert.equal((await report(borrower, { booking: bookingId, description: 'tiny' })).response.status, 400);
    assert.equal((await report(borrower, { booking: bookingId, description: 'x'.repeat(4001) })).response.status, 400);
  });

  it('rejects duplicate descriptions but permits separate incident reports', async () => {
    const first = await report(borrower, { booking: bookingId, description: 'Loose cable detected.' });
    assert.equal(first.response.status, 201);
    const duplicate = await report(borrower, { booking: bookingId, description: '  LOOSE CABLE detected. ' });
    assert.equal(duplicate.response.status, 409);
    const distinct = await report(borrower, { booking: bookingId, description: 'Missing protective cover.' });
    assert.equal(distinct.response.status, 201);
  });

  it('limits incident lists and details to reporter, resource owner, or admin', async () => {
    const id = await createReport('A separate report for access control.');
    const ownList = await (await fetch(`${baseUrl}/api/incidents/my`, { headers: { authorization: `Bearer ${borrower.token}` } })).json();
    assert.ok(ownList.data.some(item => item._id === id));
    const anotherList = await (await fetch(`${baseUrl}/api/incidents/my`, { headers: { authorization: `Bearer ${otherBorrower.token}` } })).json();
    assert.equal(anotherList.data.some(item => item._id === id), false);
    assert.equal((await fetch(`${baseUrl}/api/incidents/${id}`, { headers: { authorization: `Bearer ${otherBorrower.token}` } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/incidents/${id}`, { headers: { authorization: `Bearer ${owner.token}` } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/incidents/${id}`, { headers: { authorization: `Bearer ${admin.token}` } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/incidents/not-an-id`, { headers: { authorization: `Bearer ${borrower.token}` } })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/incidents/${id}`)).status, 401);
  });

  it('limits owner lists to owned resources and blocks unauthorized management', async () => {
    const id = await createReport('An owner scoped report for test.');
    const ownerList = await (await fetch(`${baseUrl}/api/incidents/owner`, { headers: { authorization: `Bearer ${owner.token}` } })).json();
    assert.ok(ownerList.data.some(item => item._id === id));
    const otherOwnerList = await (await fetch(`${baseUrl}/api/incidents/owner`, { headers: { authorization: `Bearer ${otherOwner.token}` } })).json();
    assert.equal(otherOwnerList.data.some(item => item._id === id), false);
    const adminList = await (await fetch(`${baseUrl}/api/incidents/owner`, { headers: { authorization: `Bearer ${admin.token}` } })).json();
    assert.ok(adminList.data.some(item => item._id === id));
    assert.equal((await fetch(`${baseUrl}/api/incidents/owner`, { headers: { authorization: `Bearer ${borrower.token}` } })).status, 403);
    assert.equal((await patch(otherOwner, id, 'review')).status, 403);
    assert.equal((await patch(borrower, id, 'review')).status, 403);
    assert.equal((await patch(otherOwner, id, 'resolve')).status, 403);
  });

  it('enforces open to review to resolved transitions and records each activity', async () => {
    const id = await createReport('A transition path issue report.');
    assert.equal((await patch(owner, id, 'resolve')).status, 409);
    assert.equal((await patch(owner, id, 'review')).status, 200);
    assert.equal((await patch(owner, id, 'review')).status, 409);
    assert.equal((await patch(owner, id, 'resolve')).status, 200);
    assert.equal((await patch(owner, id, 'resolve')).status, 409);
    const activities = await Activity.find({ relatedIncident: id }).sort({ createdAt: 1 });
    assert.deepEqual(activities.map(item => item.action), ['incident_reported', 'incident_under_review', 'incident_resolved']);
    assert.ok(activities.every(item => item.relatedBooking.toString() === bookingId && item.relatedResource.toString() === resourceId));
  });

  it('validates dismissal reason and permits dismissal directly from open or from review', async () => {
    const openId = await createReport('A report to dismiss while open.');
    assert.equal((await patch(owner, openId, 'dismiss')).status, 400);
    assert.equal((await patch(owner, openId, 'dismiss', { reason: '   ' })).status, 400);
    assert.equal((await patch(owner, openId, 'dismiss', { reason: 'Already handled.', extra: true })).status, 400);
    const dismissed = await patch(owner, openId, 'dismiss', { reason: 'Outside the equipment scope.' });
    assert.equal(dismissed.status, 200);
    const saved = (await dismissed.json()).data;
    assert.equal(saved.status, 'dismissed');
    assert.equal(saved.dismissalReason, 'Outside the equipment scope.');
    assert.equal((await patch(owner, openId, 'dismiss', { reason: 'Repeated.' })).status, 409);

    const reviewId = await createReport('A report to dismiss under review.');
    assert.equal((await patch(owner, reviewId, 'review')).status, 200);
    assert.equal((await patch(owner, reviewId, 'dismiss', { reason: 'No longer reproducible.' })).status, 200);
    assert.equal((await Activity.countDocuments({ relatedIncident: openId, action: 'incident_dismissed' })), 1);
  });

  it('does not let incident reporting or review block booking return', async () => {
    const id = await createReport('A report before the return is completed.');
    assert.equal((await patch(owner, id, 'review')).status, 200);
    const returned = await fetch(`${baseUrl}/api/bookings/${bookingId}/return`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${borrower.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ returnCondition: 'Returned safely after inspection.' })
    });
    assert.equal(returned.status, 200);
    assert.equal((await Booking.findById(bookingId)).status, 'returned');
    assert.equal((await Incident.findById(id)).status, 'review');
  });
});
