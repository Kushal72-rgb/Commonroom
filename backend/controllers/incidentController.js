const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Booking = require('../models/Booking');
const Incident = require('../models/Incident');
const Resource = require('../models/Resource');

const pageLimitMax = 100;

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function pagination(query) {
  const parse = (field, fallback, max) => {
    if (query[field] === undefined) return { value: fallback };
    if (typeof query[field] !== 'string' || !/^\d+$/.test(query[field])) return { error: `${field} must be a positive integer.` };
    const value = Number(query[field]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) return { error: `${field} must be between 1 and ${max}.` };
    return { value };
  };
  const page = parse('page', 1, 1000000);
  const limit = parse('limit', 20, pageLimitMax);
  if (page.error || limit.error) return { error: page.error || limit.error };
  return { page: page.value, limit: limit.value };
}

async function recordActivity(actor, action, incident, booking, details = {}) {
  await Activity.create({
    user: actor._id,
    action,
    relatedResource: booking.resource,
    relatedBooking: booking._id,
    relatedIncident: incident._id,
    details: { incidentId: incident._id.toString(), ...details }
  });
}

async function createIncident(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'Request body must be a JSON object.');
  const extra = Object.keys(body).find(key => !['booking', 'description'].includes(key));
  if (extra) return fail(res, 400, `Unsupported incident field: ${extra}.`);
  if (!mongoose.isValidObjectId(body.booking)) return fail(res, 400, 'A valid booking ID is required.');
  if (typeof body.description !== 'string' || !body.description.trim() || body.description.trim().length < 5 || body.description.trim().length > 4000) {
    return fail(res, 400, 'Description must contain 5 to 4000 non-whitespace characters.');
  }

  try {
    const booking = await Booking.findById(body.booking);
    if (!booking) return fail(res, 404, 'Booking not found.');
    if (!booking.borrower.equals(req.user._id)) return fail(res, 403, 'Only the borrower for this booking can report an incident.');

    const description = body.description.trim();
    const prior = await Incident.find({ booking: booking._id, reportedBy: req.user._id }).select('description');
    const duplicate = prior.some(item => item.description.trim().toLocaleLowerCase() === description.toLocaleLowerCase());
    if (duplicate) return fail(res, 409, 'A matching incident has already been reported for this booking.');

    const incident = await Incident.create({ booking: booking._id, reportedBy: req.user._id, description, status: 'open' });
    await recordActivity(req.user, 'incident_reported', incident, booking, { status: 'open' });
    return res.status(201).json({ success: true, data: incident });
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') return fail(res, 400, 'Incident data is invalid.');
    return next(err);
  }
}

async function listIncidents(req, res, next, filter) {
  const paging = pagination(req.query);
  if (paging.error) return fail(res, 400, paging.error);
  try {
    const [incidents, total] = await Promise.all([
      Incident.find(filter)
        .populate('reportedBy', 'name email')
        .populate({ path: 'booking', select: 'resource borrower startDate endDate status', populate: [
          { path: 'resource', select: 'name category location owner' },
          { path: 'borrower', select: 'name email' }
        ] })
        .sort({ createdAt: -1 })
        .skip((paging.page - 1) * paging.limit)
        .limit(paging.limit),
      Incident.countDocuments(filter)
    ]);
    return res.status(200).json({
      success: true,
      data: incidents,
      pagination: { page: paging.page, limit: paging.limit, total, pages: Math.ceil(total / paging.limit) }
    });
  } catch (err) {
    return next(err);
  }
}

function listMyIncidents(req, res, next) {
  return listIncidents(req, res, next, { reportedBy: req.user._id });
}

async function listOwnerIncidents(req, res, next) {
  try {
    if (req.user.role === 'admin') return listIncidents(req, res, next, {});
    const ownedResources = await Resource.find({ owner: req.user._id }).distinct('_id');
    const bookings = await Booking.find({ resource: { $in: ownedResources } }).distinct('_id');
    return listIncidents(req, res, next, { booking: { $in: bookings } });
  } catch (err) {
    return next(err);
  }
}

async function findAuthorizedIncident(req, res, { manage = false } = {}) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    fail(res, 400, 'Invalid incident ID.');
    return null;
  }
  const incident = await Incident.findById(req.params.id).populate({
    path: 'booking', select: 'resource borrower startDate endDate status', populate: [
      { path: 'resource', select: 'name category location owner' },
      { path: 'borrower', select: 'name email' }
    ]
  }).populate('reportedBy', 'name email');
  if (!incident) {
    fail(res, 404, 'Incident not found.');
    return null;
  }
  const admin = req.user.role === 'admin';
  const reporter = incident.reportedBy?._id.equals(req.user._id);
  const owner = incident.booking?.resource?.owner?.equals(req.user._id);
  if (manage ? (!admin && !owner) : (!admin && !owner && !reporter)) {
    fail(res, 403, 'You do not have permission to access this incident.');
    return null;
  }
  return incident;
}

async function getIncident(req, res, next) {
  try {
    const incident = await findAuthorizedIncident(req, res);
    if (!incident) return;
    return res.status(200).json({ success: true, data: incident });
  } catch (err) {
    return next(err);
  }
}

async function transitionIncident(req, res, next, { from, to, action, reason }) {
  try {
    const incident = await findAuthorizedIncident(req, res, { manage: true });
    if (!incident) return;
    if (!from.includes(incident.status)) return fail(res, 409, `Cannot move an incident from ${incident.status} to ${to}.`);
    const update = { status: to };
    if (reason) update.dismissalReason = reason;
    const updated = await Incident.findOneAndUpdate(
      { _id: incident._id, status: { $in: from } },
      { $set: update },
      { returnDocument: 'after', runValidators: true }
    );
    if (!updated) return fail(res, 409, 'Incident state changed; refresh and retry.');
    const booking = incident.booking;
    await recordActivity(req.user, action, updated, booking, {
      from: incident.status,
      to,
      ...(reason ? { reason } : {})
    });
    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') return fail(res, 400, 'Incident data is invalid.');
    return next(err);
  }
}

function reviewIncident(req, res, next) {
  if (req.body && Object.keys(req.body).length) return fail(res, 400, 'Review does not accept a request body.');
  return transitionIncident(req, res, next, { from: ['open'], to: 'review', action: 'incident_under_review' });
}

function resolveIncident(req, res, next) {
  if (req.body && Object.keys(req.body).length) return fail(res, 400, 'Resolve does not accept a request body.');
  return transitionIncident(req, res, next, { from: ['review'], to: 'resolved', action: 'incident_resolved' });
}

function dismissIncident(req, res, next) {
  const reason = req.body?.reason;
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key => key !== 'reason') || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) {
    return fail(res, 400, 'A dismissal reason of 1 to 1000 characters is required.');
  }
  return transitionIncident(req, res, next, {
    from: ['open', 'review'], to: 'dismissed', action: 'incident_dismissed', reason: reason.trim()
  });
}

module.exports = { createIncident, listMyIncidents, listOwnerIncidents, getIncident, reviewIncident, resolveIncident, dismissIncident };
