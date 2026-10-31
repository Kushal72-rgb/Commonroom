const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  resource: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Resource',
    required: [true, 'Resource is required']
  },
  // Internal fencing generation for resource-locked create/approval operations.
  resourceLockFence: {
    type: Number,
    min: 0,
    select: false
  },
  borrower: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Borrower is required']
  },
  startDate: {
    type: Date,
    required: [true, 'Booking start date is required']
  },
  endDate: {
    type: Date,
    required: [true, 'Booking end date is required'],
    validate: {
      validator(value) {
        return !this.startDate || value > this.startDate;
      },
      message: 'Booking end date must be after its start date'
    }
  },
  purpose: {
    type: String,
    required: [true, 'Booking purpose is required'],
    trim: true,
    maxlength: 1000
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'waitlisted', 'in_use', 'returned', 'cancelled'],
    default: 'pending',
    required: true
  },
  rejectionReason: {
    type: String,
    trim: true,
    maxlength: 1000
  },
  checkInCondition: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  checkInAt: {
    type: Date
  },
  checkInBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  returnCondition: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  returnedAt: {
    type: Date
  },
  returnedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

bookingSchema.set('toJSON', {
  transform(_doc, result) {
    delete result.resourceLockFence;
    return result;
  }
});

bookingSchema.index({ resource: 1, status: 1, startDate: 1, endDate: 1 });
bookingSchema.index({ borrower: 1, createdAt: -1 });

module.exports = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
