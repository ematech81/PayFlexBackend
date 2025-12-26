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
      sparse: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please use a valid email'],
    },
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [/^(\+234[789]\d{9}|0[789]\d{9})$/, 'Please enter a valid Nigerian phone number'],
    },

    // Auth
    passwordHash: { type: String, required: true, select: false },
    pinHash: { type: String, select: false },
    transactionPinHash: { type: String, select: false },

    // Verification
    isPhoneVerified: { type: Boolean, default: false },
    isEmailVerified: { type: Boolean, default: false },

    phoneOTP: { type: String, select: false },
    phoneOTPExpires: { type: Date, select: false },

    emailVerificationToken: { type: String, select: false },
    emailVerificationExpires: { type: Date, select: false },

    // Security
    devices: [{ type: String }],
    requirePinOnOpen: { type: Boolean, default: true },

    resetCode: { type: String, select: false },
    resetCodeExpires: { type: Date, select: false },

    // Wallet & KYC
    walletBalance: { type: Number, default: 0, min: 0 },
    kyc: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },

    // Roles & Metadata
    roles: { type: [String], default: ['user'] },
    lastLogin: { type: Date },
    isActive: { type: Boolean, default: true },

    // NIN Verification
    ninVerification: {
      nin: { type: String, select: false },
      firstName: String,
      middleName: String,
      surname: String,
      phoneNumber: String,
      dateOfBirth: String,
      gender: String,
      residenceState: String,
      residenceLGA: String,
      residenceAddress: { type: String, select: false },
      photo: { type: String, select: false },
      reportId: String,
      verifiedAt: Date,
      status: { type: String, enum: ['pending', 'verified', 'failed'], default: 'pending' },
    },

    isNINVerified: { type: Boolean, default: false },

    // BVN Verification
    bvnVerification: {
      bvn: { type: String, select: false },
      firstName: String,
      middleName: String,
      surname: String,
      phoneNumber: String,
      dateOfBirth: String,
      gender: String,
      reportId: String,
      verifiedAt: Date,
      status: { type: String, enum: ['pending', 'verified', 'failed'], default: 'pending' },
    },

    isBVNVerified: { type: Boolean, default: false },

    // Overall verification status
    verificationStatus: {
      type: String,
      enum: ['unverified', 'nin_verified', 'bvn_verified', 'fully_verified'],
      default: 'unverified',
    },
  },

  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
userSchema.index({ phoneOTPExpires: 1 }, { expireAfterSeconds: 0, sparse: true });
userSchema.index({ resetCodeExpires: 1 }, { expireAfterSeconds: 0, sparse: true });

// Virtual
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Pre-save hook
userSchema.pre('save', async function (next) {
  try {
    // Normalize phone
    if (this.isModified('phone') && this.phone) {
      const phone = this.phone.trim();

      if (!phone.startsWith('+')) {
        if (/^0[789]\d{9}$/.test(phone)) {
          this.phone = `+234${phone.slice(1)}`;
        } else if (/^234[789]\d{9}$/.test(phone)) {
          this.phone = `+${phone}`;
        }
      }
    }

    // Password hash
    if (this.isModified('passwordHash') && this.passwordHash) {
      if (!this.passwordHash.startsWith('$2')) {
        this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
      }
    }

    // PIN hash
    if (this.isModified('pinHash') && this.pinHash) {
      if (!String(this.pinHash).startsWith('$2')) {
        this.pinHash = await bcrypt.hash(String(this.pinHash), 10);
      }
    }

    // Transaction PIN hash
    if (this.isModified('transactionPinHash') && this.transactionPinHash) {
      if (!String(this.transactionPinHash).startsWith('$2')) {
        this.transactionPinHash = await bcrypt.hash(String(this.transactionPinHash), 10);
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Methods
userSchema.methods.validatePin = function (pin) {
  if (!this.pinHash) return false;
  return bcrypt.compare(String(pin), this.pinHash);
};

userSchema.methods.validateTransactionPin = function (pin) {
  if (!this.transactionPinHash) return false;
  return bcrypt.compare(String(pin), this.transactionPinHash);
};

userSchema.methods.isOTPValid = function () {
  return this.phoneOTP && this.phoneOTPExpires && Date.now() < this.phoneOTPExpires;
};

userSchema.methods.clearOTP = async function () {
  this.phoneOTP = undefined;
  this.phoneOTPExpires = undefined;
  await this.save();
};

module.exports = mongoose.model('User', userSchema);
