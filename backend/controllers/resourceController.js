const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Resource = require('../models/Resource');
const {
  acquireResourceBookingLock,
  assertResourceBookingLock,
  releaseResourceBookingLock
} = require('../utils/resourceBookingLock');

const writableFields = new Set([
  'name', 'description', 'category', 'location', 'availability',
  'eligibilityRequirements', 'usageRules', 'status'
]);
const resourceStatuses = new Set(['active', 'paused', 'maintenance', 'archived']);
const stringLimits = {
  name: 160,
  description: 4000,
  category: 80,
  location: 240
};

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function validateResourceInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const unknownFields = Object.keys(body).filter(field => !writableFields.has(field));
  if (unknownFields.length) {
    return { error: `Unsupported resource field: ${unknownFields[0]}.` };
  }
  if (partial && Object.keys(body).length === 0) {
    return { error: 'Provide at least one field to update.' };
  }

  const normalized = {};
  for (const [field, maxLength] of Object.entries(stringLimits)) {
    if (!(field in body)) {
      if (!partial) return { error: `${field} is required.` };
      continue;
    }
    if (typeof body[field] !== 'string') return { error: `${field} must be a string.` };
    const value = body[field].trim();
    if (!value) return { error: `${field} cannot be empty.` };
    if (value.length > maxLength) return { error: `${field} must be at most ${maxLength} characters.` };
    normalized[field] = value;
  }

  if ('availability' in body) {
    if (!Array.isArray(body.availability) || body.availability.length > 100) {
      return { error: 'availability must be an array with no more than 100 windows.' };
    }
    normalized.availability = [];
    for (const [index, window] of body.availability.entries()) {
      if (!window || typeof window !== 'object' || Array.isArray(window)) {
        return { error: `availability[${index}] must be an object.` };
      }
      const extraKeys = Object.keys(window).filter(key => !['startDate', 'endDate'].includes(key));
      if (extraKeys.length) return { error: `availability[${index}] contains an unsupported field.` };
      const startDate = typeof window.startDate === 'string' ? new Date(window.startDate) : null;
      const endDate = typeof window.endDate === 'string' ? new Date(window.endDate) : null;
      if (!startDate || !Number.isFinite(startDate.getTime())) {
        return { error: `availability[${index}].startDate must be a valid date string.` };
      }
      if (!endDate || !Number.isFinite(endDate.getTime())) {
        return { error: `availability[${index}].endDate must be a valid date string.` };
      }
      if (endDate <= startDate) return { error: `availability[${index}].endDate must be after startDate.` };
      normalized.availability.push({ startDate, endDate });
    }
  }

  for (const [field, maxItemLength] of [['eligibilityRequirements', 240], ['usageRules', 500]]) {
    if (!(field in body)) continue;
    if (!Array.isArray(body[field]) || body[field].length > 50) {
      return { error: `${field} must be an array with no more than 50 entries.` };
    }
    const entries = [];
    for (const entry of body[field]) {
      if (typeof entry !== 'string' || !entry.trim() || entry.trim().length > maxItemLength) {
        return { error: `${field} entries must be non-empty strings of at most ${maxItemLength} characters.` };
      }
      entries.push(entry.trim());
    }
    normalized[field] = entries;
  }

  if ('status' in body) {
    if (typeof body.status !== 'string' || !resourceStatuses.has(body.status)) {
      return { error: `status must be one of: ${Array.from(resourceStatuses).join(', ')}.` };
    }
    normalized.status = body.status;
  }

  return { value: normalized };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readQueryString(query, field, maxLength) {
  if (query[field] === undefined) return { value: undefined };
  if (typeof query[field] !== 'string' || query[field].length > maxLength) {
    return { error: `${field} must be a string of at most ${maxLength} characters.` };
  }
  return { value: query[field].trim() };
}

function buildListQuery(query, { includeInactive = false } = {}) {
  const parsed = {};
  for (const [field, max] of [['category', 80], ['location', 240], ['search', 200]]) {
    const result = readQueryString(query, field, max);
    if (result.error) return { error: result.error };
    parsed[field] = result.value;
  }

  const readInteger = (field, defaultValue, maxValue) => {
    if (query[field] === undefined) return { value: defaultValue };
    if (typeof query[field] !== 'string' || !/^\d+$/.test(query[field])) return { error: `${field} must be a positive integer.` };
    const value = Number(query[field]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maxValue) return { error: `${field} must be between 1 and ${maxValue}.` };
    return { value };
  };

  const page = readInteger('page', 1, 1000000);
  const limit = readInteger('limit', 20, 100);
  if (page.error || limit.error) return { error: page.error || limit.error };

  const filter = includeInactive ? {} : { status: 'active' };
  if (parsed.category) filter.category = new RegExp(`^${escapeRegex(parsed.category)}$`, 'i');
  if (parsed.location) filter.location = new RegExp(escapeRegex(parsed.location), 'i');
  if (parsed.search) {
    const term = new RegExp(escapeRegex(parsed.search), 'i');
    filter.$or = [{ name: term }, { description: term }];
  }

  return { filter, page: page.value, limit: limit.value };
}

async function list(req, res, next, ownerId, includeInactive = false) {
  const options = buildListQuery(req.query, { includeInactive });
  if (options.error) return fail(res, 400, options.error);
  if (ownerId) options.filter.owner = ownerId;

  try {
    const [resources, total] = await Promise.all([
      Resource.find(options.filter)
        .populate('owner', 'name')
        .sort({ createdAt: -1 })
        .skip((options.page - 1) * options.limit)
        .limit(options.limit),
      Resource.countDocuments(options.filter)
    ]);
    return res.status(200).json({
      success: true,
      data: resources,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        pages: Math.ceil(total / options.limit)
      }
    });
  } catch (err) {
    return next(err);
  }
}

async function createResource(req, res, next) {
  const validation = validateResourceInput(req.body);
  if (validation.error) return fail(res, 400, validation.error);

  try {
    const resource = await Resource.create({ ...validation.value, owner: req.user._id });
    const populated = await resource.populate('owner', 'name');
    return res.status(201).json({ success: true, data: populated });
  } catch (err) {
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return fail(res, 400, 'Resource data is invalid.');
    }
    return next(err);
  }
}

function listResources(req, res, next) {
  return list(req, res, next, null, req.user?.role === 'admin');
}

function listMyResources(req, res, next) {
  return list(req, res, next, req.user._id, true);
}

async function getResource(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid resource ID.');
  try {
    const resource = await Resource.findById(req.params.id).populate('owner', 'name');
    if (!resource) return fail(res, 404, 'Resource not found.');
    return res.status(200).json({ success: true, data: resource });
  } catch (err) {
    return next(err);
  }
}

async function updateResource(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid resource ID.');
  const validation = validateResourceInput(req.body, { partial: true });
  if (validation.error) return fail(res, 400, validation.error);

  let lock;
  try {
    const existing = await Resource.findById(req.params.id);
    if (!existing) return fail(res, 404, 'Resource not found.');
    if (req.user.role !== 'admin' && !existing.owner.equals(req.user._id)) {
      return fail(res, 403, 'You may only update resources you own.');
    }

    lock = await acquireResourceBookingLock(req.params.id, { requireActive: false });
    if (lock.error) return fail(res, lock.error.status, lock.error.message);
    const resource = lock.resource;
    if (req.user.role !== 'admin' && !resource.owner.equals(req.user._id)) {
      return fail(res, 403, 'You may only update resources you own.');
    }

    const oldStatus = resource.status;
    if (oldStatus === 'archived' && validation.value.status === 'active') {
      resource.set(validation.value);
      await resource.validate();
    }

    await assertResourceBookingLock(lock);
    const updated = await Resource.findOneAndUpdate(
      {
        _id: req.params.id,
        approvalLockToken: lock.token,
        approvalLockFence: lock.fence,
        approvalLockExpiresAt: { $gt: new Date() }
      },
      { $set: validation.value },
      { returnDocument: 'after', runValidators: true }
    ).populate('owner', 'name');
    if (!updated) return fail(res, 409, 'Resource changed or its lock lease expired; retry shortly.');
    if (oldStatus !== updated.status && ['archived', 'active'].includes(updated.status)) {
      await Activity.create({
        user: req.user._id,
        action: updated.status === 'archived' ? 'resource_archived' : 'resource_restored',
        relatedResource: updated._id,
        details: { from: oldStatus, to: updated.status }
      });
    }
    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    if (err.code === 'RESOURCE_LOCK_LOST') return fail(res, 409, err.message);
    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return fail(res, 400, 'Resource data is invalid.');
    }
    return next(err);
  } finally {
    if (lock?.token) await releaseResourceBookingLock(lock);
  }
}

async function deleteResource(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, 'Invalid resource ID.');
  try {
    const resource = await Resource.findById(req.params.id);
    if (!resource) return fail(res, 404, 'Resource not found.');
    if (req.user.role !== 'admin' && !resource.owner.equals(req.user._id)) {
      return fail(res, 403, 'You may only delete resources you own.');
    }

    const lock = await acquireResourceBookingLock(req.params.id, { requireActive: false });
    if (lock.error) return fail(res, lock.error.status, lock.error.message);
    try {
      if (lock.resource.status === 'archived') {
        return res.status(200).json({ success: true, message: 'Resource is already archived.', data: { id: lock.resource.id, status: 'archived' } });
      }
      await assertResourceBookingLock(lock);
      const archived = await Resource.findOneAndUpdate(
        {
          _id: req.params.id,
          approvalLockToken: lock.token,
          approvalLockFence: lock.fence,
          approvalLockExpiresAt: { $gt: new Date() }
        },
        { $set: { status: 'archived' } },
        { returnDocument: 'after', runValidators: true }
      );
      if (!archived) return fail(res, 409, 'Resource changed while it was being archived; retry shortly.');
      await Activity.create({
        user: req.user._id,
        action: 'resource_archived',
        relatedResource: archived._id,
        details: { from: lock.resource.status, to: 'archived' }
      });
      return res.status(200).json({ success: true, message: 'Resource archived.', data: { id: archived.id, status: archived.status } });
    } finally {
      await releaseResourceBookingLock(lock);
    }
  } catch (err) {
    if (err.code === 'RESOURCE_LOCK_LOST') return fail(res, 409, err.message);
    return next(err);
  }
}

module.exports = {
  createResource,
  listResources,
  listMyResources,
  getResource,
  updateResource,
  deleteResource,
  validateResourceInput,
  buildListQuery
};
