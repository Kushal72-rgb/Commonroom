const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: 120
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address'],
    maxlength: 254
  },
  // Excluded from queries by default; auth handlers select it only to verify credentials.
  password: {
    type: String,
    required: [true, 'Password is required'],
    select: false
  },
  role: {
    type: String,
    enum: ['member', 'owner', 'manager', 'admin'],
    default: 'member',
    required: true
  },
  verifiedEligibility: {
    type: [{ type: String, trim: true, maxlength: 240 }],
    default: [],
    select: false
  }
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
