const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');
const Resource = require('../models/Resource');
const User = require('../models/User');
const {
  acquireResourceBookingLock,
  assertResourceBookingLock,
  releaseResourceBookingLock
} = require('../utils/resourceBookingLock');

const requestFields = new Set(['resource', 'startDate', 'endDate', 'purpose']);
const maxPageSize = 100;

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ success: false, error, ...extra });
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/.exec(value);
  if (!match) return null;
  const calendarDate = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (!Number.isFinite(calendarDate.getTime()) ||
      calendarDate.getUTCFullYear() !== Number(match[1]) ||
      calendarDate.getUTCMonth() + 1 !== Number(match[2]) ||
      calendarDate.getUTCDate() !== Number(match[3])) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parsePage(query) {
  const read = (field, fallback, max) => {
    if (query[field] === undefined) return { value: fallback };
    if (typeof query[field] !== 'string' || !/^\d+$/.test(query[field])) return { error: `${field} must be a positive integer.` };
    const value = Number(query[field]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) return { error: `${field} must be between 1 and ${max}.` };
    return { value };
  };
  const page = read('page', 1, 1000000);
  const limit = read('limit', 20, maxPageSize);
  if (page.error || limit.error) return { error: page.error || limit.error };
  return { page: page.value, limit: limit.value };
}

async function recordActivity(actor, action, booking, details = {}) {
  await Activity.create({
    user: actor._id,
    action,
    relatedResource: booking.resource,
    relatedBooking: booking._id,
    details
  });
}

async function createBooking(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'Request body must be a JSON object.');
  const unsupportedField = Object.keys(body).find(field => !requestFields.has(field));
  if (unsupportedField) return fail(res, 400, `Unsupported booking field: ${unsupportedField}.`);
  if (!mongoose.isValidObjectId(body.resource)) return fail(res, 400, 'A valid resource ID is required.');

  const startDate = parseDate(body.startDate);
  const endDate = parseDate(body.endDate);
  if (!startDate || !endDate) return fail(res, 400, 'Valid startDate and endDate values are required.');
  if (endDate <= startDate) return fail(res, 400, 'endDate must be after startDate.');
  if (startDate < new Date()) return fail(res, 400, 'Bookings cannot start in the past.');
  if (typeof body.purpose !== 'string' || !body.purpose.trim() || body.purpose.trim().length > 1000) {
    return fail(res, 400, 'Purpose is required and must be at most 1000 characters.');
  }

  let lock;
  try {
    lock = await acquireResourceBookingLock(body.resource);
    if (lock.error) return fail(res, lock.error.status, lock.error.message);
    const resource = lock.resource;

    const borrower = await User.findById(req.user._id).select('+verifiedEligibility');
    if (!borrower) return fail(res, 401, 'Authenticated user no longer exists.');
    const verified = new Set((borrower.verifiedEligibility || []).map(item => item.trim().toLocaleLowerCase()));
    const missingRequirements = (resource.eligibilityRequirements || []).filter(
      requirement => !verified.has(requirement.trim().toLocaleLowerCase())
    );
    if (missingRequirements.length) {
      return fail(res, 403, 'Verified eligibility requirements are not satisfied.', { missingRequirements });
    }

    await assertResourceBookingLock(lock);
    const booking = await Booking.create({
      resource: resource._id,
      resourceLockFence: lock.fence,
      borrower: borrower._id,
      startDate,
      endDate,
      purpose: body.purpose.trim(),
      status: 'pending'
    });
    try {
      await assertResourceBookingLock(lock);
    } catch (error) {
      if (error.code === 'RESOURCE_LOCK_LOST') {
        // The request was created after this lease was displaced; remove only this
        // still-pending operation before reporting that it must be retried.
        await Booking.deleteOne({ _id: booking._id, status: 'pending' });
      }
      throw error;
    }
    await recordActivity(borrower, 'booking_requested', booking, {
      startDate,
      endDate,
      purpose: booking.purpose,
      status: booking.status
    });
    return res.status(201).json({ success: true, data: booking });
  } catch (err) {
    if (err.code === 'RESOURCE_LOCK_LOST') return fail(res, 409, err.message);
    if (err.name === 'ValidationError' || err.name === 'CastError') return fail(res, 400, 'Booking data is invalid.');
    return next(err);
  } finally {
    if (lock?.token) await releaseResourceBookingLock(lock);
  }
}

async function listBookings(req, res, next, filter) {
  const pagination = parsePage(req.query);
  if (pagination.error) return fail(res, 400, pagination.error);
  try {
    const [bookings, total] = await Promise.all([
      Booking.find(filter)
        .populate('resource', 'name category location owner')
        .populate('borrower', 'name email')
        .sort({ createdAt: -1 })
        .skip((pagination.page - 1) * pagination.limit)
        .limit(pagination.limit),
      Booking.countDocuments(filter)
    ]);
    return res.status(200).json({
      success: true,
      data: bookings,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        pages: Math.ceil(total / pagination.limit)
      }
    });
  } catch (err) {
    return next(err);
  }
}

function listMyBookings(req, res, next) {
  return listBookings(req, res, next, { borrower: req.user._id });
}

async function listOwnerBookings(req, res, next) {
  try {
    if (req.user.role === 'admin') return listBookings(req, res, next, {});
    const resourceIds = await Resource.find({ owner: req.user._id }).distinct('_id');
    return listBookings(req, res, next, { resource: { $in: resourceIds } });
  } catch (err) {
    return next(err);
  }
}

async function findAuthorizedBooking(req, res, { requireManager = false } = {}) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    fail(res, 400, 'Invalid booking ID.');
    return null;
  }

  const booking = await Booking.findById(req.params.id)
    .populate('resource', 'name category location owner')
    .populate('borrower', 'name email');
  if (!booking) {
    fail(res, 404, 'Booking not found.');
    return null;
  }

  const isAdmin = req.user.role === 'admin';
  const isBorrower = booking.borrower?._id.equals(req.user._id);
  const isResourceOwner = booking.resource?.owner?.equals(req.user._id);
  if (requireManager ? (!isAdmin && !isResourceOwner) : (!isAdmin && !isResourceOwner && !isBorrower)) {
    fail(res, 403, 'You do not have permission to access this booking.');
    return null;
  }
  return booking;
}

async function getBooking(req, res, next) {
  try {
    const booking = await findAuthorizedBooking(req, res);
    if (!booking) return;
    return res.status(200).json({ success: true, data: booking });
  } catch (err) {
    return next(err);
  }
}

async function authorizedTransition(req, res, next, { from, to, action, reason, updates = {}, requireManager = true }) {
  try {
    const booking = await findAuthorizedBooking(req, res, { requireManager });
    if (!booking) return;
    if (!from.includes(booking.status)) return fail(res, 409, `Cannot ${action} a booking in the ${booking.status} state.`);

    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, status: { $in: from } },
      { $set: { ...updates, status: to } },
      { returnDocument: 'after', runValidators: true }
    );
    if (!updated) return fail(res, 409, 'Booking state changed; refresh and retry.');

    const details = { from: booking.status, to };
    if (reason) details.reason = reason;
    if (updates.returnCondition) details.returnCondition = updates.returnCondition;
    if (updates.checkInCondition) details.checkInCondition = updates.checkInCondition;
    await recordActivity(req.user, action, updated, details);
    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') return fail(res, 400, 'Booking data is invalid.');
    return next(err);
  }
}

async function approveBooking(req, res, next) {
  let lockLease;
  try {
    const booking = await findAuthorizedBooking(req, res, { requireManager: true });
    if (!booking) return;
    if (!booking.resource) return fail(res, 409, 'The resource linked to this booking no longer exists.');
    if (!['pending', 'waitlisted'].includes(booking.status)) {
      return fail(res, 409, `Cannot approve a booking in the ${booking.status} state.`);
    }

    const lock = await acquireResourceBookingLock(booking.resource._id);
    if (lock.error) return fail(res, lock.error.status, lock.error.message);
    lockLease = lock;

    const latest = await Booking.findById(booking._id);
    if (!latest || !['pending', 'waitlisted'].includes(latest.status)) {
      return fail(res, 409, 'Booking state changed; refresh and retry.');
    }
    if (latest.startDate < new Date()) return fail(res, 409, 'Cannot approve a booking whose start date has passed.');
    const borrower = await User.findById(latest.borrower).select('+verifiedEligibility');
    if (!borrower) return fail(res, 409, 'Booking borrower no longer exists.');
    const verified = new Set((borrower.verifiedEligibility || []).map(item => item.trim().toLocaleLowerCase()));
    const missingRequirements = (lock.resource.eligibilityRequirements || []).filter(
      requirement => !verified.has(requirement.trim().toLocaleLowerCase())
    );
    if (missingRequirements.length) {
      return fail(res, 403, 'Verified eligibility requirements are not satisfied.', { missingRequirements });
    }
    const conflict = await Booking.exists({
      _id: { $ne: latest._id },
      resource: latest.resource,
      status: { $in: ['approved', 'in_use'] },
      startDate: { $lt: latest.endDate },
      endDate: { $gt: latest.startDate }
    });
    if (conflict) return fail(res, 409, 'This time overlaps an approved booking for the resource.');

    await assertResourceBookingLock(lockLease);
    const from = latest.status;
    const approved = await Booking.findOneAndUpdate(
      {
        _id: latest._id,
        status: { $in: ['pending', 'waitlisted'] },
        resourceLockFence: lockLease.fence
      },
      { $set: { status: 'approved' }, $unset: { rejectionReason: 1 } },
      { returnDocument: 'after', runValidators: true }
    );
    if (!approved) return fail(res, 409, 'Booking state changed; refresh and retry.');
    await recordActivity(req.user, 'booking_approved', approved, { from, to: 'approved' });
    return res.status(200).json({ success: true, data: approved });
  } catch (err) {
    if (err.code === 'RESOURCE_LOCK_LOST') return fail(res, 409, err.message);
    return next(err);
  } finally {
    if (lockLease) await releaseResourceBookingLock(lockLease);
  }
}

async function rejectBooking(req, res, next) {
  const reason = req.body?.reason;
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) {
    return fail(res, 400, 'A rejection reason of 1 to 1000 characters is required.');
  }
  return authorizedTransition(req, res, next, {
    from: ['pending', 'waitlisted'],
    to: 'rejected',
    action: 'booking_rejected',
    reason: reason.trim(),
    updates: { rejectionReason: reason.trim() }
  });
}

function waitlistBooking(req, res, next) {
  return authorizedTransition(req, res, next, {
    from: ['pending'], to: 'waitlisted', action: 'booking_waitlisted'
  });
}

async function cancelBooking(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid booking ID.');
    const booking = await Booking.findById(req.params.id);
    if (!booking) return fail(res, 404, 'Booking not found.');
    if (!booking.borrower.equals(req.user._id)) return fail(res, 403, 'Only the borrower can cancel this booking.');
    if (!['pending', 'waitlisted', 'approved'].includes(booking.status)) {
      return fail(res, 409, `Cannot cancel a booking in the ${booking.status} state.`);
    }

    const from = booking.status;
    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, status: { $in: ['pending', 'waitlisted', 'approved'] } },
      { $set: { status: 'cancelled' } },
      { returnDocument: 'after', runValidators: true }
    );
    if (!updated) return fail(res, 409, 'Booking state changed; refresh and retry.');
    await recordActivity(req.user, 'booking_cancelled', updated, { from, to: 'cancelled' });
    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    return next(err);
  }
}

function validateCheckInBody(body) {
  if (body === undefined) return { value: {} };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object.' };
  const extra = Object.keys(body).find(key => key !== 'checkInCondition');
  if (extra) return { error: `Unsupported check-in field: ${extra}.` };
  if (body.checkInCondition !== undefined && (typeof body.checkInCondition !== 'string' || body.checkInCondition.trim().length > 2000)) {
    return { error: 'checkInCondition must be a string of at most 2000 characters.' };
  }
  return { value: body.checkInCondition?.trim() ? { checkInCondition: body.checkInCondition.trim() } : {} };
}

async function checkInBooking(req, res, next) {
  const validation = validateCheckInBody(req.body);
  if (validation.error) return fail(res, 400, validation.error);
  return authorizedTransition(req, res, next, {
    from: ['approved'],
    to: 'in_use',
    action: 'borrower_checked_in',
    updates: { ...validation.value, checkInAt: new Date(), checkInBy: req.user._id }
  });
}

async function returnBooking(req, res, next) {
  const condition = req.body?.returnCondition;
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key => key !== 'returnCondition') ||
      typeof condition !== 'string' || !condition.trim() || condition.trim().length > 2000) {
    return fail(res, 400, 'returnCondition is required and must be at most 2000 characters.');
  }
  return authorizedTransition(req, res, next, {
    from: ['in_use'],
    to: 'returned',
    action: 'resource_returned',
    requireManager: false,
    updates: { returnCondition: condition.trim(), returnedAt: new Date(), returnedBy: req.user._id }
  });
}

module.exports = {
  createBooking,
  listMyBookings,
  listOwnerBookings,
  getBooking,
  approveBooking,
  rejectBooking,
  waitlistBooking,
  cancelBooking,
  checkInBooking,
  returnBooking
};
