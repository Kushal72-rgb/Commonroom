const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Resource = require('../models/Resource');

async function releaseApprovalLock() {
  if (process.env.ALLOW_LOCAL_LOCK_RECOVERY !== 'true' || process.env.CONFIRM_NO_COMMONROOM_API_RUNNING !== 'true') {
    throw new Error('Recovery requires explicit opt-in and confirmation that all Commonroom API processes are stopped.');
  }

  let parsedUri;
  try {
    parsedUri = new URL(process.env.MONGODB_URI);
  } catch {
    throw new Error('MONGODB_URI is invalid.');
  }
  if (parsedUri.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(parsedUri.hostname) || parsedUri.pathname !== '/commonroom') {
    throw new Error('Lock recovery is restricted to the local commonroom database.');
  }

  const resourceId = process.env.RESOURCE_ID;
  if (!mongoose.isValidObjectId(resourceId)) throw new Error('A valid RESOURCE_ID is required.');
  await connectDB();

  const resource = await Resource.findById(resourceId).select('_id +approvalLockToken');
  if (!resource) throw new Error('Resource not found.');
  if (!resource.approvalLockToken) {
    console.log('No approval lock is present for this resource.');
    return;
  }

  await Resource.updateOne(
    { _id: resource._id, approvalLockToken: resource.approvalLockToken },
    { $unset: { approvalLockToken: 1, approvalLockExpiresAt: 1 } }
  );
  console.log('Approval lock released.');
}

releaseApprovalLock()
  .catch(() => {
    console.error('Could not recover the approval lock. Verify the local database, resource ID, and stopped-server confirmation.');
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
