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
const User = require('../models/User');
const Resource = require('../models/Resource');
const { app } = require('../server');

describe('Commonroom resource API', { concurrency: false }, () => {
  const suffix = new mongoose.Types.ObjectId().toString();
  const users = [];
  const resourceIds = [];
  const bookingIds = [];
  const incidentIds = [];
  const activityIds = [];
  let owner;
  let otherOwner;
  let member;
  let manager;
  let admin;
  let server;
  let baseUrl;
  let laserId;
  let studioId;
  let managerResourceId;
  let userCounter = 0;

  async function createUser(role) {
    const user = await User.create({
      name: `Resource Test ${role}`,
      email: `${role}-${suffix}-${++userCounter}@example.invalid`,
      password: await bcrypt.hash('TestPassword-123!', 4),
      role
    });
    users.push(user._id);
    return {
      id: user._id.toString(),
      token: jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
    };
  }

  function resourceBody(name, category, location) {
    return {
      name,
      description: `Description for ${name}`,
      category,
      location,
      availability: [{
        startDate: '2030-01-01T10:00:00.000Z',
        endDate: '2030-01-01T12:00:00.000Z'
      }],
      eligibilityRequirements: ['Campus induction'],
      usageRules: ['Return in good condition']
    };
  }

  async function postResource(actor, body) {
    const response = await fetch(`${baseUrl}/api/resources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${actor.token}` },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (response.status === 201 && result.data?._id) resourceIds.push(result.data._id);
    return { response, result };
  }

  before(async () => {
    assert.ok(process.env.JWT_SECRET && Buffer.byteLength(process.env.JWT_SECRET, 'utf8') >= 32,
      'Set a JWT_SECRET in backend/.env before running resource tests.');
    await connectDB();
    await User.init();
    await Resource.init();
    [owner, otherOwner, member, manager, admin] = await Promise.all([
      createUser('owner'), createUser('owner'), createUser('member'), createUser('manager'), createUser('admin')
    ]);

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (activityIds.length) await Activity.deleteMany({ _id: { $in: activityIds } });
    if (resourceIds.length) await Activity.deleteMany({ relatedResource: { $in: resourceIds } });
    if (incidentIds.length) await Incident.deleteMany({ _id: { $in: incidentIds } });
    if (bookingIds.length) await Booking.deleteMany({ _id: { $in: bookingIds } });
    if (resourceIds.length) await Resource.deleteMany({ _id: { $in: resourceIds } });
    if (users.length) await User.deleteMany({ _id: { $in: users } });
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    await mongoose.disconnect();
  });

  it('allows an owner to create a resource and assigns ownership from the token', async () => {
    const first = await postResource(owner, resourceBody(`Audit Laser ${suffix}`, 'Equipment', `Audit Lab ${suffix}`));
    const second = await postResource(owner, resourceBody(`Audit Studio ${suffix}`, 'Spaces', `Audit Annex ${suffix}`));
    assert.equal(first.response.status, 201);
    assert.equal(first.result.success, true);
    assert.equal(first.result.data.owner._id, owner.id);
    assert.equal(second.response.status, 201);
    laserId = first.result.data._id;
    studioId = second.result.data._id;
  });

  it('blocks members and rejects client-supplied ownership', async () => {
    const memberResult = await postResource(member, resourceBody('Should not exist', 'Equipment', 'Test Lab'));
    assert.equal(memberResult.response.status, 403);

    const forgedOwner = await postResource(owner, {
      ...resourceBody('Forged resource', 'Equipment', 'Test Lab'),
      owner: otherOwner.id
    });
    assert.equal(forgedOwner.response.status, 400);
  });

  it('lists resources with search, category, location, pagination, and owner scope', async () => {
    const publicList = await fetch(`${baseUrl}/api/resources?limit=5`);
    const publicBody = await publicList.json();
    assert.equal(publicList.status, 200);
    assert.equal(publicBody.success, true);
    assert.ok(publicBody.data.some(resource => resource._id === laserId));
    assert.equal(publicBody.pagination.limit, 5);

    const search = await (await fetch(`${baseUrl}/api/resources?search=${encodeURIComponent(suffix)}`)).json();
    assert.ok(search.data.some(resource => resource._id === laserId));

    const category = await (await fetch(`${baseUrl}/api/resources?category=equipment`)).json();
    assert.ok(category.data.some(resource => resource._id === laserId));
    assert.ok(category.data.every(resource => resource.category.toLowerCase() === 'equipment'));

    const location = await (await fetch(`${baseUrl}/api/resources?location=${encodeURIComponent(`Audit Lab ${suffix}`)}`)).json();
    assert.equal(location.data.length, 1);
    assert.equal(location.data[0]._id, laserId);

    const mineResponse = await fetch(`${baseUrl}/api/resources/my`, { headers: { authorization: `Bearer ${owner.token}` } });
    const mine = await mineResponse.json();
    assert.equal(mineResponse.status, 200);
    assert.deepEqual(new Set(mine.data.map(resource => resource._id)), new Set([laserId, studioId]));
    assert.equal((await fetch(`${baseUrl}/api/resources/my`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/resources/my`, { headers: { authorization: `Bearer ${member.token}` } })).status, 403);
  });

  it('returns resource details and validates MongoDB IDs', async () => {
    const detail = await fetch(`${baseUrl}/api/resources/${laserId}`);
    const body = await detail.json();
    assert.equal(detail.status, 200);
    assert.equal(body.data._id, laserId);
    assert.equal(body.data.name, `Audit Laser ${suffix}`);

    for (const [method, url] of [
      ['GET', `${baseUrl}/api/resources/not-an-object-id`],
      ['PUT', `${baseUrl}/api/resources/not-an-object-id`],
      ['DELETE', `${baseUrl}/api/resources/not-an-object-id`]
    ]) {
      const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ name: 'Updated' }) : undefined
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).success, false);
    }
  });

  it('validates create and update fields', async () => {
    const blank = await postResource(owner, resourceBody('   ', 'Equipment', 'Test Lab'));
    assert.equal(blank.response.status, 400);

    const invalidWindow = await postResource(owner, {
      ...resourceBody('Bad window', 'Equipment', 'Test Lab'),
      availability: [{ startDate: '2030-01-02T12:00:00.000Z', endDate: '2030-01-02T10:00:00.000Z' }]
    });
    assert.equal(invalidWindow.response.status, 400);

    const emptyUpdate = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'PUT', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(emptyUpdate.status, 400);
  });

  it('allows the owner to update, but not another owner or a member', async () => {
    const update = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Updated by the owner.', status: 'paused' })
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).data.description, 'Updated by the owner.');

    const ownerInventory = await (await fetch(`${baseUrl}/api/resources/my`, {
      headers: { authorization: `Bearer ${owner.token}` }
    })).json();
    assert.ok(ownerInventory.data.some(resource => resource._id === laserId));
    const publicInventory = await (await fetch(`${baseUrl}/api/resources`)).json();
    assert.equal(publicInventory.data.some(resource => resource._id === laserId), false);

    const otherOwnerUpdate = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${otherOwner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Unauthorized update.' })
    });
    assert.equal(otherOwnerUpdate.status, 403);
    const afterDeniedUpdate = await Resource.findById(laserId).select('+approvalLockToken +approvalLockExpiresAt');
    assert.equal(afterDeniedUpdate.approvalLockToken, undefined);
    assert.equal(afterDeniedUpdate.approvalLockExpiresAt, undefined);

    const memberUpdate = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Borrower update.' })
    });
    assert.equal(memberUpdate.status, 403);

    const ownershipChange = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ owner: otherOwner.id })
    });
    assert.equal(ownershipChange.status, 400);
  });

  it('restricts managers to owned resources and allows admins to manage all resources', async () => {
    const managerCreate = await postResource(manager, resourceBody(`Manager Resource ${suffix}`, 'Technology', `Manager Lab ${suffix}`));
    assert.equal(managerCreate.response.status, 201);
    managerResourceId = managerCreate.result.data._id;

    const managerOwnUpdate = await fetch(`${baseUrl}/api/resources/${managerResourceId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${manager.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Manager updated own resource.' })
    });
    assert.equal(managerOwnUpdate.status, 200);

    const managerOtherUpdate = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${manager.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Manager may not update another owner resource.' })
    });
    assert.equal(managerOtherUpdate.status, 403);

    const adminCreate = await postResource(admin, resourceBody(`Admin Resource ${suffix}`, 'Technology', `Admin Lab ${suffix}`));
    assert.equal(adminCreate.response.status, 201);
    assert.equal(adminCreate.result.data.owner._id, admin.id);

    const adminUpdate = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'maintenance' })
    });
    assert.equal(adminUpdate.status, 200);
    assert.equal((await adminUpdate.json()).data.status, 'maintenance');

    const adminInventory = await (await fetch(`${baseUrl}/api/resources`, {
      headers: { authorization: `Bearer ${admin.token}` }
    })).json();
    assert.ok(adminInventory.data.some(resource => resource._id === laserId));
  });

  it('enforces deletion permissions and lets an admin manage another owner resource', async () => {
    const forbidden = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${otherOwner.token}` }
    });
    assert.equal(forbidden.status, 403);

    const memberDelete = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${member.token}` }
    });
    assert.equal(memberDelete.status, 403);

    const booking = await Booking.create({
      resource: laserId, borrower: member.id,
      startDate: new Date(Date.now() + 86400000), endDate: new Date(Date.now() + 90000000),
      purpose: 'Archive preservation test', status: 'returned'
    });
    bookingIds.push(booking._id);
    const incident = await Incident.create({ booking: booking._id, reportedBy: member.id, description: 'Archive preservation incident.' });
    incidentIds.push(incident._id);
    const activity = await Activity.create({ user: member.id, action: 'archive_preservation_test', relatedResource: laserId, relatedBooking: booking._id, relatedIncident: incident._id });
    activityIds.push(activity._id);

    const adminDelete = await fetch(`${baseUrl}/api/resources/${laserId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${admin.token}` }
    });
    assert.equal(adminDelete.status, 200);
    assert.equal((await adminDelete.json()).data.status, 'archived');
    assert.equal((await Resource.findById(laserId)).status, 'archived');
    assert.ok(await Booking.findById(booking._id));
    assert.ok(await Incident.findById(incident._id));
    assert.ok(await Activity.findById(activity._id));
    assert.equal((await fetch(`${baseUrl}/api/bookings/${booking._id}`, { headers: { authorization: `Bearer ${member.token}` } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/incidents/${incident._id}`, { headers: { authorization: `Bearer ${member.token}` } })).status, 200);
    const resourceHistory = await fetch(`${baseUrl}/api/activity/resource/${laserId}`, { headers: { authorization: `Bearer ${admin.token}` } });
    assert.equal(resourceHistory.status, 200);
    assert.ok((await resourceHistory.json()).data.some(item => item.action === 'resource_archived'));
    assert.equal((await fetch(`${baseUrl}/api/resources/${laserId}`)).status, 200);
    const activeResources = await (await fetch(`${baseUrl}/api/resources`)).json();
    assert.equal(activeResources.data.some(item => item._id === laserId), false);

    const ownerDelete = await fetch(`${baseUrl}/api/resources/${studioId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${owner.token}` }
    });
    assert.equal(ownerDelete.status, 200);
    assert.equal((await Resource.findById(studioId)).status, 'archived');
    await Resource.updateOne({ _id: studioId }, { $unset: { name: 1 } });
    const invalidRestore = await fetch(`${baseUrl}/api/resources/${studioId}`, {
      method: 'PUT', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' })
    });
    assert.equal(invalidRestore.status, 400);
    const restore = await fetch(`${baseUrl}/api/resources/${studioId}`, {
      method: 'PUT', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active', name: 'Restored studio resource' })
    });
    assert.equal(restore.status, 200);
    assert.equal((await restore.json()).data.status, 'active');
    assert.equal((await fetch(`${baseUrl}/api/resources`)).status, 200);
    const archiveAgain = await fetch(`${baseUrl}/api/resources/${studioId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${owner.token}` }
    });
    assert.equal(archiveAgain.status, 200);
    assert.equal((await (await fetch(`${baseUrl}/api/resources/${studioId}`)).json()).data.status, 'archived');
  });
});
