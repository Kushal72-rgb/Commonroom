require('dotenv').config({ quiet: true });

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');
const Incident = require('../models/Incident');
const Resource = require('../models/Resource');
const User = require('../models/User');
const { acquireResourceBookingLock, releaseResourceBookingLock } = require('../utils/resourceBookingLock');
const { app } = require('../server');

describe('Commonroom booking API', { concurrency: false }, () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const userIds = [];
  const resourceIds = [];
  const bookingIds = [];
  const incidentIds = [];
  let owner;
  let otherOwner;
  let borrower;
  let secondBorrower;
  let ineligibleBorrower;
  let admin;
  let resourceId;
  let inactiveResourceId;
  let server;
  let baseUrl;
  let userCounter = 0;
  const password = 'TestPassword-123!';

  async function createUser(role, verifiedEligibility = []) {
    const user = await User.create({
      name: `Booking Test ${role}`,
      email: `${role}-${suffix}-${++userCounter}@example.invalid`,
      password: await bcrypt.hash(password, 4),
      role,
      verifiedEligibility
    });
    userIds.push(user._id);
    return {
      id: user._id.toString(),
      token: jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
    };
  }

  function dateRange(offsetHours, durationHours = 1) {
    const base = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    base.setMinutes(0, 0, 0);
    const startDate = new Date(base.getTime() + offsetHours * 60 * 60 * 1000);
    const endDate = new Date(startDate.getTime() + durationHours * 60 * 60 * 1000);
    return { startDate: startDate.toISOString(), endDate: endDate.toISOString() };
  }

  function requestBody(offsetHours, overrides = {}) {
    return {
      resource: resourceId,
      ...dateRange(offsetHours),
      purpose: `Prototype session ${suffix}`,
      ...overrides
    };
  }

  async function createRequest(actor, offsetHours, overrides = {}) {
    const response = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody(offsetHours, overrides))
    });
    const result = await response.json();
    if (response.status === 201 && result.data?._id) bookingIds.push(result.data._id);
    return { response, result };
  }

  async function patchBooking(actor, id, action, body) {
    return fetch(`${baseUrl}/api/bookings/${id}/${action}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  before(async () => {
    assert.ok(process.env.JWT_SECRET && Buffer.byteLength(process.env.JWT_SECRET, 'utf8') >= 32,
      'Set a JWT_SECRET in backend/.env before running booking tests.');
    await connectDB();
    await Promise.all([User.init(), Resource.init(), Booking.init(), Activity.init(), Incident.init()]);
    [owner, otherOwner, borrower, secondBorrower, ineligibleBorrower, admin] = await Promise.all([
      createUser('owner'),
      createUser('owner'),
      createUser('member', ['Laser safety']),
      createUser('member', ['Laser safety']),
      createUser('member'),
      createUser('admin')
    ]);

    const resource = await Resource.create({
      name: `Booking Test Resource ${suffix}`,
      description: 'A fictional integration-test resource.',
      category: 'Equipment',
      location: 'Test Makerspace',
      owner: owner.id,
      eligibilityRequirements: ['Laser safety'],
      availability: [{
        startDate: '2030-01-01T00:00:00.000Z',
        endDate: '2035-01-01T00:00:00.000Z'
      }],
      status: 'active'
    });
    resourceId = resource._id.toString();
    resourceIds.push(resource._id);
    const inactiveResource = await Resource.create({
      name: `Paused Test Resource ${suffix}`,
      description: 'An unavailable fictional test resource.',
      category: 'Equipment',
      location: 'Test Makerspace',
      owner: owner.id,
      availability: [{ startDate: '2030-01-01T00:00:00.000Z', endDate: '2035-01-01T00:00:00.000Z' }],
      status: 'paused'
    });
    inactiveResourceId = inactiveResource._id.toString();
    resourceIds.push(inactiveResource._id);

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

  it('creates a pending booking with borrower identity from the token', async () => {
    const result = await createRequest(borrower, 0);
    assert.equal(result.response.status, 201);
    assert.equal(result.result.success, true);
    assert.equal(result.result.data.borrower, borrower.id);
    assert.equal(result.result.data.status, 'pending');
    assert.equal(Object.hasOwn(result.result.data, 'resourceLockFence'), false);
  });

  it('rejects invalid resources, invalid or past dates, invalid purpose, and borrower impersonation', async () => {
    const invalidId = await createRequest(borrower, 1, { resource: 'not-an-object-id' });
    assert.equal(invalidId.response.status, 400);

    const missingResource = await createRequest(borrower, 1, { resource: new mongoose.Types.ObjectId().toString() });
    assert.equal(missingResource.response.status, 404);

    const inactive = await createRequest(borrower, 1, { resource: inactiveResourceId });
    assert.equal(inactive.response.status, 409);
    await Resource.updateOne({ _id: inactiveResourceId }, { $set: { status: 'archived' } });
    const archived = await createRequest(borrower, 1, { resource: inactiveResourceId });
    assert.equal(archived.response.status, 409);
    await Resource.updateOne({ _id: inactiveResourceId }, { $set: { status: 'paused' } });

    const invalidDate = await createRequest(borrower, 1, { startDate: 'not-a-date' });
    assert.equal(invalidDate.response.status, 400);

    const invalidCalendarDate = await createRequest(borrower, 1, { startDate: '2030-02-30T10:00:00.000Z' });
    assert.equal(invalidCalendarDate.response.status, 400);

    const reverseDates = await createRequest(borrower, 1, { ...dateRange(3), endDate: dateRange(2).startDate });
    assert.equal(reverseDates.response.status, 400);

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const pastDate = await createRequest(borrower, 1, { startDate: past });
    assert.equal(pastDate.response.status, 400);

    const noPurpose = await createRequest(borrower, 1, { purpose: '   ' });
    assert.equal(noPurpose.response.status, 400);

    const impersonation = await createRequest(borrower, 1, { borrower: secondBorrower.id });
    assert.equal(impersonation.response.status, 400);
  });

  it('requires stored verified eligibility instead of trusting the request body', async () => {
    const noEligibility = await createRequest(ineligibleBorrower, 2, { eligibilityAcknowledged: true });
    assert.equal(noEligibility.response.status, 400);

    const result = await createRequest(ineligibleBorrower, 2);
    assert.equal(result.response.status, 403);
    assert.deepEqual(result.result.missingRequirements, ['Laser safety']);
    const afterFailure = await Resource.findById(resourceId).select('+approvalLockToken +approvalLockExpiresAt');
    assert.equal(afterFailure.approvalLockToken, undefined);
    assert.equal(afterFailure.approvalLockExpiresAt, undefined);
  });

  it('does not let booking creation or resource archiving bypass another active resource lease', async () => {
    const bookingLease = await acquireResourceBookingLock(resourceId);
    try {
      const blockedBooking = await createRequest(borrower, 24);
      assert.equal(blockedBooking.response.status, 409);

      const blockedArchive = await fetch(`${baseUrl}/api/resources/${resourceId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${owner.token}` }
      });
      assert.equal(blockedArchive.status, 409);
    } finally {
      await releaseResourceBookingLock(bookingLease);
    }

    // An archive operation uses the same lock with requireActive:false.
    const archiveLease = await acquireResourceBookingLock(resourceId, { requireActive: false });
    try {
      const blockedByArchive = await createRequest(borrower, 25);
      assert.equal(blockedByArchive.response.status, 409);
    } finally {
      await releaseResourceBookingLock(archiveLease);
    }
  });

  it('rechecks current verified eligibility when an owner approves a request', async () => {
    const pending = await createRequest(borrower, 3);
    assert.equal(pending.response.status, 201);
    await User.updateOne({ _id: borrower.id }, { $set: { verifiedEligibility: [] } });
    const approval = await patchBooking(owner, pending.result.data._id, 'approve');
    assert.equal(approval.status, 403);
    assert.deepEqual((await approval.json()).missingRequirements, ['Laser safety']);
    assert.equal((await Booking.findById(pending.result.data._id)).status, 'pending');
    await User.updateOne({ _id: borrower.id }, { $set: { verifiedEligibility: ['Laser safety'] } });
  });

  it('limits borrower lists and booking details to authorized users', async () => {
    const second = await createRequest(secondBorrower, 2);
    assert.equal(second.response.status, 201);
    const ownList = await (await fetch(`${baseUrl}/api/bookings/my`, {
      headers: { authorization: `Bearer ${borrower.token}` }
    })).json();
    assert.ok(ownList.data.some(item => item.borrower._id === borrower.id));
    assert.equal(ownList.data.some(item => item.borrower._id === secondBorrower.id), false);

    const ownId = (await Booking.findOne({ borrower: borrower.id }))._id.toString();
    const ownDetail = await fetch(`${baseUrl}/api/bookings/${ownId}`, { headers: { authorization: `Bearer ${borrower.token}` } });
    assert.equal(ownDetail.status, 200);

    const privateDetail = await fetch(`${baseUrl}/api/bookings/${ownId}`, { headers: { authorization: `Bearer ${secondBorrower.token}` } });
    assert.equal(privateDetail.status, 403);
    assert.equal((await fetch(`${baseUrl}/api/bookings/${ownId}`)).status, 401);
  });

  it('shows owners only requests for their resources and admins all requests', async () => {
    const ownerList = await (await fetch(`${baseUrl}/api/bookings/owner`, {
      headers: { authorization: `Bearer ${owner.token}` }
    })).json();
    assert.ok(ownerList.data.length >= 2);
    assert.ok(ownerList.data.every(item => item.resource.owner.toString() === owner.id));

    const otherOwnerList = await (await fetch(`${baseUrl}/api/bookings/owner`, {
      headers: { authorization: `Bearer ${otherOwner.token}` }
    })).json();
    assert.equal(otherOwnerList.data.length, 0);

    const adminList = await (await fetch(`${baseUrl}/api/bookings/owner`, {
      headers: { authorization: `Bearer ${admin.token}` }
    })).json();
    assert.ok(adminList.data.length >= ownerList.data.length);
    assert.equal((await fetch(`${baseUrl}/api/bookings/owner`, { headers: { authorization: `Bearer ${borrower.token}` } })).status, 403);
  });

  it('blocks unauthorized owners and members from approving or rejecting', async () => {
    const pending = await createRequest(secondBorrower, 4);
    const id = pending.result.data._id;
    const otherOwnerApprove = await patchBooking(otherOwner, id, 'approve');
    assert.equal(otherOwnerApprove.status, 403);
    const memberReject = await patchBooking(borrower, id, 'reject', { reason: 'Not permitted.' });
    assert.equal(memberReject.status, 403);
  });

  it('approves a pending booking and rejects repeated or invalid transitions', async () => {
    const pending = await createRequest(borrower, 6);
    const id = pending.result.data._id;
    const approved = await patchBooking(owner, id, 'approve');
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).data.status, 'approved');

    assert.equal((await patchBooking(owner, id, 'approve')).status, 409);
    assert.equal((await patchBooking(owner, id, 'waitlist')).status, 409);
    assert.equal((await patchBooking(owner, id, 'check-in')).status, 200);
    assert.equal((await patchBooking(owner, id, 'check-in')).status, 409);
  });

  it('requires a rejection reason and records the rejection', async () => {
    const pending = await createRequest(secondBorrower, 8);
    const id = pending.result.data._id;
    assert.equal((await patchBooking(owner, id, 'reject')).status, 400);
    assert.equal((await patchBooking(owner, id, 'reject', { reason: '   ' })).status, 400);
    const rejected = await patchBooking(owner, id, 'reject', { reason: 'Staff supervision is unavailable.' });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).data.rejectionReason, 'Staff supervision is unavailable.');
    assert.equal((await patchBooking(owner, id, 'reject', { reason: 'Again.' })).status, 409);
  });

  it('requires explicit owner action to approve a waitlisted request', async () => {
    const pending = await createRequest(borrower, 10);
    const id = pending.result.data._id;
    assert.equal((await patchBooking(owner, id, 'waitlist')).status, 200);
    assert.equal((await patchBooking(owner, id, 'approve')).status, 200);
    assert.equal((await Booking.findById(id)).status, 'approved');
  });

  it('prevents overlapping approvals but allows non-overlapping bookings', async () => {
    const first = await createRequest(borrower, 12);
    const overlapping = await createRequest(secondBorrower, 12.5);
    assert.equal(first.response.status, 201);
    assert.equal(overlapping.response.status, 201); // Pending requests do not reserve the slot.
    assert.equal((await patchBooking(owner, first.result.data._id, 'approve')).status, 200);
    assert.equal((await patchBooking(owner, overlapping.result.data._id, 'approve')).status, 409);

    const nonOverlapping = await createRequest(secondBorrower, 14);
    assert.equal(nonOverlapping.response.status, 201);
    assert.equal((await patchBooking(owner, nonOverlapping.result.data._id, 'approve')).status, 200);
  });

  it('serializes simultaneous approval attempts for overlapping bookings', async () => {
    const first = await createRequest(borrower, 20);
    const second = await createRequest(secondBorrower, 20.5);
    const results = await Promise.all([
      patchBooking(owner, first.result.data._id, 'approve'),
      patchBooking(owner, second.result.data._id, 'approve')
    ]);
    const statuses = results.map(response => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);

    const saved = await Booking.find({ _id: { $in: [first.result.data._id, second.result.data._id] } });
    assert.equal(saved.filter(item => item.status === 'approved').length, 1);
  });

  it('allows borrower-only cancellation from eligible states', async () => {
    const pending = await createRequest(borrower, 24);
    const id = pending.result.data._id;
    assert.equal((await patchBooking(secondBorrower, id, 'cancel')).status, 403);
    assert.equal((await patchBooking(owner, id, 'cancel')).status, 403);
    assert.equal((await patchBooking(borrower, id, 'cancel')).status, 200);
    assert.equal((await patchBooking(borrower, id, 'cancel')).status, 409);

    const approved = await createRequest(borrower, 26);
    assert.equal((await patchBooking(owner, approved.result.data._id, 'approve')).status, 200);
    assert.equal((await patchBooking(borrower, approved.result.data._id, 'cancel')).status, 200);
  });

  it('records check-in and return metadata separately, even with an open incident', async () => {
    const pending = await createRequest(borrower, 28);
    const id = pending.result.data._id;
    assert.equal((await patchBooking(owner, id, 'approve')).status, 200);

    const checkIn = await patchBooking(owner, id, 'check-in', { checkInCondition: 'Inspected before use.' });
    assert.equal(checkIn.status, 200);
    const inUse = await Booking.findById(id);
    assert.ok(inUse.checkInAt instanceof Date);
    assert.equal(inUse.checkInBy.toString(), owner.id);

    const competing = await createRequest(secondBorrower, 28);
    assert.equal(competing.response.status, 201);
    assert.equal((await patchBooking(owner, competing.result.data._id, 'approve')).status, 409);

    const incident = await Incident.create({
      booking: id,
      reportedBy: borrower.id,
      description: 'A minor issue reported before return.',
      status: 'open'
    });
    incidentIds.push(incident._id);

    const returned = await patchBooking(owner, id, 'return', { returnCondition: 'Returned to staff in good condition.' });
    assert.equal(returned.status, 200);
    const saved = await Booking.findById(id);
    assert.equal(saved.status, 'returned');
    assert.ok(saved.returnedAt instanceof Date);
    assert.equal(saved.returnedBy.toString(), owner.id);
    assert.equal(saved.returnCondition, 'Returned to staff in good condition.');
    assert.equal((await Incident.findById(incident._id)).status, 'open');
    assert.equal((await patchBooking(owner, id, 'return', { returnCondition: 'Again.' })).status, 409);

    const actions = await Activity.find({ relatedBooking: id }).sort({ createdAt: 1 });
    assert.deepEqual(actions.map(item => item.action), [
      'booking_requested', 'booking_approved', 'borrower_checked_in', 'resource_returned'
    ]);
    assert.equal(actions[0].user.toString(), borrower.id);
    assert.equal(actions[1].user.toString(), owner.id);
    assert.equal(actions[2].user.toString(), owner.id);
    assert.equal(actions[3].user.toString(), owner.id);
    assert.ok(actions.every(item => item.relatedResource.toString() === resourceId));
  });

  it('records each required booking action in Activity', async () => {
    const actions = new Set(await Activity.distinct('action', { relatedBooking: { $in: bookingIds } }));
    for (const action of [
      'booking_requested', 'booking_approved', 'booking_rejected', 'booking_waitlisted',
      'booking_cancelled', 'borrower_checked_in', 'resource_returned'
    ]) {
      assert.ok(actions.has(action), `Missing activity action: ${action}`);
    }
    const malformedId = await fetch(`${baseUrl}/api/bookings/not-an-object-id`, {
      headers: { authorization: `Bearer ${borrower.token}` }
    });
    assert.equal(malformedId.status, 400);
  });
});
