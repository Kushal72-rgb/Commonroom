'use strict';

const { randomUUID } = require('node:crypto');
const Booking = require('../models/Booking');
const Resource = require('../models/Resource');

const MIN_LEASE_MS = 5000;
const MAX_LEASE_MS = 15 * 60 * 1000;

function configuredLeaseMs(value = process.env.RESOURCE_LOCK_LEASE_MS) {
  if (value === undefined || value === '') return 60_000;
  const leaseMs = Number(value);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new Error(`RESOURCE_LOCK_LEASE_MS must be an integer between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}.`);
  }
  return leaseMs;
}

const DEFAULT_LEASE_MS = configuredLeaseMs();

function lockLostError() {
  const error = new Error('The resource lock lease expired or was acquired by another operation. Retry the request.');
  error.code = 'RESOURCE_LOCK_LOST';
  error.status = 409;
  return error;
}

async function renewResourceBookingLock(lock) {
  if (!lock || lock.released || lock.lost) return false;
  if (lock.renewalPromise) return lock.renewalPromise;

  const now = new Date();
  const nextExpiry = new Date(Math.max(
    now.getTime() + lock.leaseMs,
    (lock.expiresAt?.getTime?.() || 0) + 1
  ));
  const operation = Resource.updateOne(
    {
      _id: lock.resourceId,
      approvalLockToken: lock.token,
      approvalLockFence: lock.fence,
      approvalLockExpiresAt: { $gt: now }
    },
    { $set: { approvalLockExpiresAt: nextExpiry } },
    { timestamps: false }
  ).then(result => {
    if (result.modifiedCount !== 1) lock.lost = true;
    else lock.expiresAt = nextExpiry;
    return !lock.lost;
  }).catch(error => {
    lock.lost = true;
    throw error;
  }).finally(() => {
    lock.renewalPromise = null;
  });
  lock.renewalPromise = operation;
  return operation;
}

function stopResourceBookingLockRenewal(lock) {
  if (lock?.renewalTimer) {
    clearInterval(lock.renewalTimer);
    lock.renewalTimer = null;
  }
}

function startRenewal(lock) {
  lock.renewalTimer = setInterval(() => {
    renewResourceBookingLock(lock).catch(() => {});
  }, Math.max(1000, Math.floor(lock.leaseMs / 3)));
  lock.renewalTimer.unref?.();
}

async function acquireResourceBookingLock(resourceId, { requireActive = true, leaseMs = DEFAULT_LEASE_MS } = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 25 || leaseMs > MAX_LEASE_MS) {
    throw new TypeError(`leaseMs must be an integer between 25 and ${MAX_LEASE_MS}.`);
  }

  const token = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const filter = {
    _id: resourceId,
    $or: [
      { approvalLockToken: null },
      { approvalLockExpiresAt: { $lte: now } },
      // Treat legacy, non-expiring locks as stale after all old API instances are drained.
      { approvalLockExpiresAt: { $exists: false } }
    ]
  };
  if (requireActive) filter.status = 'active';

  const resource = await Resource.findOneAndUpdate(
    filter,
    {
      $set: {
        approvalLockToken: token,
        approvalLockExpiresAt: expiresAt
      },
      $inc: { approvalLockFence: 1 }
    },
    { returnDocument: 'after', timestamps: false }
  ).select('+approvalLockExpiresAt +approvalLockFence');
  if (resource) {
    const lock = {
      resourceId: resource._id,
      token,
      fence: resource.approvalLockFence,
      leaseMs,
      expiresAt,
      resource,
      lost: false,
      released: false,
      renewalPromise: null,
      renewalTimer: null
    };
    startRenewal(lock);
    try {
      // Fence pending approval candidates before this holder evaluates or changes them.
      // A stale holder's booking update must match the prior generation and will then fail.
      await Booking.updateMany(
        { resource: resource._id, status: { $in: ['pending', 'waitlisted'] } },
        { $set: { resourceLockFence: lock.fence } },
        { timestamps: false }
      );
      await assertResourceBookingLock(lock);
      return lock;
    } catch (error) {
      await releaseResourceBookingLock(lock);
      throw error;
    }
  }

  const current = await Resource.findById(resourceId).select('_id status');
  if (!current) return { error: { status: 404, message: 'Resource not found.' } };
  if (requireActive && current.status !== 'active') {
    return { error: { status: 409, message: 'Resource is not active.' } };
  }
  return { error: { status: 409, message: 'Another booking operation for this resource is in progress; retry shortly.' } };
}

async function assertResourceBookingLock(lock) {
  const renewed = await renewResourceBookingLock(lock);
  if (!renewed) throw lockLostError();
  return true;
}

async function releaseResourceBookingLock(lock) {
  if (!lock || lock.released) return;
  lock.released = true;
  stopResourceBookingLockRenewal(lock);
  try {
    await Resource.updateOne(
      {
        _id: lock.resourceId,
        approvalLockToken: lock.token,
        approvalLockFence: lock.fence
      },
      { $unset: { approvalLockToken: 1, approvalLockExpiresAt: 1 } },
      { timestamps: false }
    );
  } catch {
    // A failed release is recoverable when the lease expires.
    console.error('Resource booking lock release failed; the lease will expire automatically.');
  }
}

module.exports = {
  DEFAULT_LEASE_MS,
  configuredLeaseMs,
  acquireResourceBookingLock,
  renewResourceBookingLock,
  assertResourceBookingLock,
  releaseResourceBookingLock,
  stopResourceBookingLockRenewal
};
