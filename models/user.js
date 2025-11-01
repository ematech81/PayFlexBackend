// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    // Personal Info
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please use a valid email'],
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [/^\d{10,15}$/, 'Please enter a valid phone number'],
    },

    // Auth
    passwordHash: { type: String, select: false }, // Hashed password
    pinHash: { type: String, select: false }, // 6-digit login PIN
    transactionPinHash: { type: String, select: false }, // 4-digit transaction PIN

    // Verification
    isPhoneVerified: { type: Boolean, default: false },
    verificationCode: { type: String }, // OTP for phone / device
    verificationCodeExpires: { type: Date },

    // Security
    devices: [{ type: String }], // Known device IDs
    requirePinOnOpen: { type: Boolean, default: true },
    resetCode: { type: String }, // For forgot PIN
    resetCodeExpires: { type: Date },

    // Wallet & KYC
    walletBalance: { type: Number, default: 0 },
    kyc: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },

    // Roles & Metadata
    roles: { type: [String], default: ['user'] },
    lastLogin: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes

userSchema.index({ verificationCode: 1, verificationCodeExpires: 1 });
userSchema.index({ resetCode: 1, resetCodeExpires: 1 });

// Virtual: full name
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Pre-save: Hash password, PINs
userSchema.pre('save', async function (next) {
  try {
    // Hash password (only if modified and not already hashed)
    if (this.isModified('passwordHash') && this.passwordHash) {
      this.passwordHash = await bcrypt.hash(this.passwordHash, 10);
    }

    // Hash login PIN
    if (this.isModified('pinHash') && this.pinHash) {
      this.pinHash = await bcrypt.hash(String(this.pinHash), 10);
    }

    // Hash transaction PIN
    if (this.isModified('transactionPinHash') && this.transactionPinHash) {
      this.transactionPinHash = await bcrypt.hash(String(this.transactionPinHash), 10);
    }

    next();
  } catch (error) {
    next(error);
  }
});

// Instance method: Validate PIN
userSchema.methods.validatePin = async function (pin) {
  return await bcrypt.compare(String(pin), this.pinHash);
};

// Instance method: Validate Transaction PIN
userSchema.methods.validateTransactionPin = async function (pin) {
  return await bcrypt.compare(String(pin), this.transactionPinHash);
};

module.exports = mongoose.model('User', userSchema);