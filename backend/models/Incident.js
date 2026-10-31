const mongoose = require('mongoose');

const incidentSchema = new mongoose.Schema({
  booking: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: [true, 'Related booking is required']
  },
  reportedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Reporter is required']
  },
  description: {
    type: String,
    required: [true, 'Incident description is required'],
    trim: true,
    maxlength: 4000
  },
  dismissalReason: {
    type: String,
    trim: true,
    maxlength: 1000
  },
  status: {
    type: String,
    enum: ['open', 'review', 'resolved', 'dismissed'],
    default: 'open',
    required: true
  }
}, { timestamps: true });

incidentSchema.index({ booking: 1, createdAt: -1 });
incidentSchema.index({ reportedBy: 1, createdAt: -1 });
incidentSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.Incident || mongoose.model('Incident', incidentSchema);
