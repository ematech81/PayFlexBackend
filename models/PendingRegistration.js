const mongoose = require('mongoose');

const pendingRegistrationSchema = new mongoose.Schema({
  firstName:    { type: String, required: true },
  lastName:     { type: String, required: true },
  email:        { type: String, required: true, lowercase: true },
  phone:        { type: String, required: true },
  passwordHash: { type: String, required: true, select: false },
  otpHash:      { type: String, required: true, select: false },
  otpExpires:   { type: Date,   required: true },
  createdAt:    { type: Date,   default: Date.now },
});

// Auto-delete documents 15 minutes after creation
pendingRegistrationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 900 });

// Unique constraints so two attempts with same email/phone can't coexist
pendingRegistrationSchema.index({ email: 1 }, { unique: true });
pendingRegistrationSchema.index({ phone: 1 }, { unique: true });

module.exports = mongoose.model('PendingRegistration', pendingRegistrationSchema);
