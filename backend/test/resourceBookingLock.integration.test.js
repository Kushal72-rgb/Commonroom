require('dotenv').config({ quiet: true });

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Booking = require('../models/Booking');
const Resource = require('../models/Resource');
const User = require('../models/User');
const {
  acquireResourceBookingLock,
  assertResourceBookingLock,
  releaseResourceBookingLock,
  stopResourceBookingLockRenewal
} = require('../utils/resourceBookingLock');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('resource booking lease integration', { concurrency: false }, () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  let owner;
  let borrower;
  let resource;
  let booking;

  before(async () => {
    await connectDB();
    [owner, borrower] = await Promise.all([
      User.create({ name: 'Lock Owner', email: `lock-owner-${suffix}@example.invalid`, password: await bcrypt.hash('TestPassword-123!', 4), role: 'owner' }),
      User.create({ name: 'Lock Borrower', email: `lock-borrower-${suffix}@example.invalid`, password: await bcrypt.hash('TestPassword-123!', 4), role: 'member' })
    ]);
    resource = await Resource.create({
      name: `Lock Resource ${suffix}`,
      description: 'Resource for lease integration tests.',
      category: 'Equipment',
      location: 'Lock Test Lab',
      owner: owner._id,
      availability: []
    });
    booking = await Booking.create({
      resource: resource._id,
      borrower: borrower._id,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 25 * 60 * 60 * 1000),
      purpose: 'Verify stale lease holders cannot approve.',
      status: 'pending'
    });
  });

  after(async () => {
    if (resource) await Resource.deleteOne({ _id: resource._id });
    if (booking) await Booking.deleteOne({ _id: booking._id });
    if (owner && borrower) await User.deleteMany({ _id: { $in: [owner._id, borrower._id] } });
    await mongoose.disconnect();
  });

  it('allows only one of two simultaneous database acquisitions', async () => {
    const results = await Promise.all([
      acquireResourceBookingLock(resource._id, { leaseMs: 1000 }),
      acquireResourceBookingLock(resource._id, { leaseMs: 1000 })
    ]);
    const acquired = results.filter(result => result.token);
    const rejected = results.filter(result => result.error);
    assert.equal(acquired.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].error.status, 409);
    await releaseResourceBookingLock(acquired[0]);
  });

  it('allows a new acquisition after the old lease expires without manual edits', async () => {
    const first = await acquireResourceBookingLock(resource._id, { leaseMs: 300 });
    assert.ok(first.token);
    stopResourceBookingLockRenewal(first);
    await pause(380);
    const second = await acquireResourceBookingLock(resource._id, { leaseMs: 1000 });
    assert.ok(second.token);
    assert.notEqual(second.token, first.token);
    await releaseResourceBookingLock(first);
    await releaseResourceBookingLock(second);
  });

  it('does not let an old token release a newer holder lock', async () => {
    const oldHolder = await acquireResourceBookingLock(resource._id, { leaseMs: 300 });
    stopResourceBookingLockRenewal(oldHolder);
    await pause(380);
    const newHolder = await acquireResourceBookingLock(resource._id, { leaseMs: 1000 });
    await releaseResourceBookingLock(oldHolder);
    const current = await Resource.findById(resource._id).select('+approvalLockToken +approvalLockExpiresAt +approvalLockFence');
    assert.equal(current.approvalLockToken, newHolder.token);
    assert.equal(current.approvalLockFence, newHolder.fence);
    await releaseResourceBookingLock(newHolder);
  });

  it('rejects a stale holder before it can commit an approval after takeover', async () => {
    const stale = await acquireResourceBookingLock(resource._id, { leaseMs: 300 });
    stopResourceBookingLockRenewal(stale);
    await pause(380);
    const current = await acquireResourceBookingLock(resource._id, { leaseMs: 1000 });
    const staleCommit = async () => {
      await assertResourceBookingLock(stale);
      return Booking.findOneAndUpdate(
        { _id: booking._id, status: 'pending' },
        { $set: { status: 'approved' } },
        { returnDocument: 'after' }
      );
    };
    await assert.rejects(staleCommit(), /lease expired|acquired by another operation/);
    const fencedOut = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'pending', resourceLockFence: stale.fence },
      { $set: { status: 'approved' } },
      { returnDocument: 'after' }
    );
    assert.equal(fencedOut, null);
    assert.equal((await Booking.findById(booking._id)).status, 'pending');
    await releaseResourceBookingLock(stale);
    await releaseResourceBookingLock(current);
  });

  it('simulates a crashed process by stopping renewal and omitting release', async () => {
    const crashedHolder = await acquireResourceBookingLock(resource._id, { leaseMs: 300 });
    stopResourceBookingLockRenewal(crashedHolder);
    // This models process death: no finally block runs; the database lease is left intact.
    await pause(380);
    const recovery = await acquireResourceBookingLock(resource._id, { leaseMs: 1000 });
    assert.ok(recovery.token);
    assert.notEqual(recovery.token, crashedHolder.token);
    await releaseResourceBookingLock(recovery);
  });

  it('renews a lease during an operation longer than one renewal interval', async () => {
    const lock = await acquireResourceBookingLock(resource._id, { leaseMs: 2500 });
    const originalExpiry = lock.expiresAt;
    await pause(1150);
    await assertResourceBookingLock(lock);
    const current = await Resource.findById(resource._id).select('+approvalLockExpiresAt');
    assert.ok(current.approvalLockExpiresAt > originalExpiry);
    await releaseResourceBookingLock(lock);
  });

  it('releases its own lease from a finally block after a protected operation errors', async () => {
    let lock;
    try {
      lock = await acquireResourceBookingLock(resource._id, { leaseMs: 1000 });
      throw new Error('simulated operation failure');
    } catch (error) {
      assert.match(error.message, /simulated operation failure/);
    } finally {
      await releaseResourceBookingLock(lock);
    }
    const next = await acquireResourceBookingLock(resource._id, { leaseMs: 1000 });
    assert.ok(next.token);
    await releaseResourceBookingLock(next);
  });
});
