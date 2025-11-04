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
      sparse: true, // Allow null/undefined for optional email
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please use a valid email'],
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      // ✅ FIXED: Now accepts E.164 format (+234...) and Nigerian format (0...)
      match: [/^(\+234[789]\d{9}|0[789]\d{9})$/, 'Please enter a valid Nigerian phone number'],
    },

    // Auth
    passwordHash: { type: String, required: true, select: false }, // Hashed password
    pinHash: { type: String, select: false }, // 6-digit login PIN
    transactionPinHash: { type: String, select: false }, // 4-digit transaction PIN

    // Verification (consolidated OTP fields)
    isPhoneVerified: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },
    
    // Phone OTP
    phoneOTP: { type: String, select: false }, // Hashed OTP
    phoneOTPExpires: { type: Date, select: false },
    
    // Email verification (if needed)
    emailVerificationToken: { type: String, select: false },
    emailVerificationExpires: { type: Date, select: false },

    // Security
    devices: [{ type: String }], // Known device IDs
    requirePinOnOpen: { type: Boolean, default: true },
    
    // PIN Reset
    resetCode: { type: String, select: false }, // For forgot PIN
    resetCodeExpires: { type: Date, select: false },

    // Wallet & KYC
    walletBalance: { type: Number, default: 0, min: 0 },
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

// Indexes for performance

userSchema.index({ phoneOTPExpires: 1 }, { expireAfterSeconds: 0, sparse: true });
userSchema.index({ resetCodeExpires: 1 }, { expireAfterSeconds: 0, sparse: true });

// Virtual: full name
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Pre-save hook: Normalize phone to E.164 format and hash passwords
userSchema.pre('save', async function (next) {
  try {
    // ✅ Normalize phone to E.164 format
    if (this.isModified('phone') && this.phone) {
      const phone = this.phone.trim();
      
      // Convert Nigerian format to E.164
      if (!phone.startsWith('+')) {
        if (/^0[789]\d{9}$/.test(phone)) {
          // 08012345678 → +2348012345678
          this.phone = `+234${phone.slice(1)}`;
        } else if (/^234[789]\d{9}$/.test(phone)) {
          // 2348012345678 → +2348012345678
          this.phone = `+${phone}`;
        }
      }
    }

    // Hash password (only if modified and not already hashed)
    if (this.isModified('passwordHash') && this.passwordHash) {
      // Check if already hashed (bcrypt hashes start with $2a$ or $2b$)
      if (!this.passwordHash.startsWith('$2')) {
        this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
      }
    }

    // Hash login PIN
    if (this.isModified('pinHash') && this.pinHash) {
      if (!String(this.pinHash).startsWith('$2')) {
        this.pinHash = await bcrypt.hash(String(this.pinHash), 10);
      }
    }

    // Hash transaction PIN
    if (this.isModified('transactionPinHash') && this.transactionPinHash) {
      if (!String(this.transactionPinHash).startsWith('$2')) {
        this.transactionPinHash = await bcrypt.hash(String(this.transactionPinHash), 10);
      }
    }

    next();
  } catch (error) {
    next(error);
  }
});

// Instance method: Validate PIN
userSchema.methods.validatePin = async function (pin) {
  if (!this.pinHash) return false;
  return await bcrypt.compare(String(pin), this.pinHash);
};

// Instance method: Validate Transaction PIN
userSchema.methods.validateTransactionPin = async function (pin) {
  if (!this.transactionPinHash) return false;
  return await bcrypt.compare(String(pin), this.transactionPinHash);
};

// Instance method: Check if OTP is valid and not expired
userSchema.methods.isOTPValid = function () {
  return this.phoneOTP && this.phoneOTPExpires && Date.now() < this.phoneOTPExpires;
};

// Instance method: Clear OTP after verification
userSchema.methods.clearOTP = async function () {
  this.phoneOTP = undefined;
  this.phoneOTPExpires = undefined;
  await this.save();
};

module.exports = mongoose.model('User', userSchema);