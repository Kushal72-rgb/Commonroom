const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');
const Resource = require('../models/Resource');

const secretKeyPattern = /password|token|secret|credential|authorization|cookie|privatekey|jwt/i;

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function parseFilters(query) {
  const readInt = (field, fallback, max) => {
    if (query[field] === undefined) return { value: fallback };
    if (typeof query[field] !== 'string' || !/^\d+$/.test(query[field])) return { error: `${field} must be a positive integer.` };
    const value = Number(query[field]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) return { error: `${field} must be between 1 and ${max}.` };
    return { value };
  };
  const page = readInt('page', 1, 1000000);
  const limit = readInt('limit', 20, 100);
  if (page.error || limit.error) return { error: page.error || limit.error };

  const filter = {};
  if (query.action !== undefined) {
    if (typeof query.action !== 'string' || !query.action.trim() || query.action.trim().length > 160) {
      return { error: 'action must be a non-empty string of at most 160 characters.' };
    }
    filter.action = query.action.trim();
  }
  const dates = {};
  for (const field of ['startDate', 'endDate']) {
    if (query[field] === undefined) continue;
    if (typeof query[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(query[field])) {
      return { error: `${field} must be a valid ISO date or UTC timestamp.` };
    }
    const date = new Date(query[field]);
    if (!Number.isFinite(date.getTime())) return { error: `${field} must be a valid ISO date or UTC timestamp.` };
    const [year, month, day] = query[field].slice(0, 10).split('-').map(Number);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      return { error: `${field} must be a valid ISO date or UTC timestamp.` };
    }
    dates[field] = date;
  }
  if (dates.startDate && dates.endDate && dates.endDate <= dates.startDate) {
    return { error: 'endDate must be after startDate.' };
  }
  if (dates.startDate || dates.endDate) {
    filter.createdAt = {};
    if (dates.startDate) filter.createdAt.$gte = dates.startDate;
    if (dates.endDate) filter.createdAt.$lt = dates.endDate;
  }
  return { page: page.value, limit: limit.value, filter };
}

function sanitizeDetails(value) {
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (value instanceof Date || value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]')
      .replace(/\b(password|token|secret|credential|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  }
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!secretKeyPattern.test(key)) safe[key] = sanitizeDetails(nested);
  }
  return safe;
}

function safeActivity(activity) {
  const item = activity.toObject ? activity.toObject() : activity;
  return { ...item, details: sanitizeDetails(item.details || {}) };
}

async function listActivity(req, res, next, baseFilter) {
  const parsed = parseFilters(req.query);
  if (parsed.error) return fail(res, 400, parsed.error);
  const filter = { ...baseFilter, ...parsed.filter };
  try {
    const [items, total] = await Promise.all([
      Activity.find(filter)
        .select('-__v')
        .populate('user', 'name email')
        .populate('relatedResource', 'name category location status')
        .populate('relatedBooking', 'startDate endDate status')
        .populate('relatedIncident', 'description status')
        .sort({ createdAt: -1, _id: -1 })
        .skip((parsed.page - 1) * parsed.limit)
        .limit(parsed.limit),
      Activity.countDocuments(filter)
    ]);
    return res.status(200).json({
      success: true,
      data: items.map(safeActivity),
      pagination: { page: parsed.page, limit: parsed.limit, total, pages: Math.ceil(total / parsed.limit) }
    });
  } catch (err) {
    return next(err);
  }
}

function myActivity(req, res, next) {
  return listActivity(req, res, next, { user: req.user._id });
}

async function resourceActivity(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.resourceId)) return fail(res, 400, 'Invalid resource ID.');
  try {
    const resource = await Resource.findById(req.params.resourceId).select('_id owner');
    if (!resource) return fail(res, 404, 'Resource not found.');
    if (req.user.role !== 'admin' && !resource.owner.equals(req.user._id)) {
      return fail(res, 403, 'Only the resource owner or an admin may view this activity.');
    }
    return listActivity(req, res, next, { relatedResource: resource._id });
  } catch (err) {
    return next(err);
  }
}

async function bookingActivity(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.bookingId)) return fail(res, 400, 'Invalid booking ID.');
  try {
    const booking = await Booking.findById(req.params.bookingId).populate('resource', 'owner');
    if (!booking) return fail(res, 404, 'Booking not found.');
    const permitted = req.user.role === 'admin' || booking.borrower.equals(req.user._id) || booking.resource?.owner?.equals(req.user._id);
    if (!permitted) return fail(res, 403, 'Only the borrower, resource owner, or an admin may view this activity.');
    return listActivity(req, res, next, { relatedBooking: booking._id });
  } catch (err) {
    return next(err);
  }
}

function allActivity(req, res, next) {
  return listActivity(req, res, next, {});
}

module.exports = { myActivity, resourceActivity, bookingActivity, allActivity, parseFilters, sanitizeDetails };
