const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Activity user is required']
  },
  action: {
    type: String,
    required: [true, 'Activity action is required'],
    trim: true,
    maxlength: 160
  },
  relatedResource: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Resource',
    default: null
  },
  relatedBooking: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    default: null
  },
  relatedIncident: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Incident',
    default: null
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({})
  }
}, { timestamps: true });

activitySchema.index({ user: 1, createdAt: -1 });
activitySchema.index({ relatedResource: 1, createdAt: -1 });
activitySchema.index({ relatedBooking: 1, createdAt: -1 });
activitySchema.index({ relatedIncident: 1, createdAt: -1 });

module.exports = mongoose.models.Activity || mongoose.model('Activity', activitySchema);
