const mongoose = require('mongoose');

const availabilityWindowSchema = new mongoose.Schema({
  startDate: {
    type: Date,
    required: [true, 'Availability start date is required']
  },
  endDate: {
    type: Date,
    required: [true, 'Availability end date is required'],
    validate: {
      validator(value) {
        return !this.startDate || value > this.startDate;
      },
      message: 'Availability end date must be after its start date'
    }
  }
}, { _id: false });

const resourceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Resource name is required'],
    trim: true,
    maxlength: 160
  },
  description: {
    type: String,
    required: [true, 'Resource description is required'],
    trim: true,
    maxlength: 4000
  },
  category: {
    type: String,
    required: [true, 'Resource category is required'],
    trim: true,
    maxlength: 80
  },
  location: {
    type: String,
    required: [true, 'Resource location is required'],
    trim: true,
    maxlength: 240
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Resource owner is required']
  },
  availability: {
    type: [availabilityWindowSchema],
    required: true,
    default: []
  },
  eligibilityRequirements: {
    type: [{ type: String, trim: true, maxlength: 240 }],
    default: []
  },
  usageRules: {
    type: [{ type: String, trim: true, maxlength: 500 }],
    default: []
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'maintenance', 'archived'],
    default: 'active',
    required: true
  },
  // Atomic per-resource lease; monotonic fence changes whenever a new holder acquires it.
  approvalLockToken: {
    type: String,
    select: false
  },
  approvalLockExpiresAt: {
    type: Date,
    select: false
  },
  approvalLockFence: {
    type: Number,
    default: 0,
    min: 0,
    select: false
  }
}, { timestamps: true });

resourceSchema.index({ status: 1, category: 1, location: 1 });
resourceSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.models.Resource || mongoose.model('Resource', resourceSchema);
