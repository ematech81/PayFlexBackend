const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      required: true,
    },
    passwordHash: { type: String, required: true }, // bcrypt hash for password
    pinHash: { type: String, default: null }, // bcrypt hash for 6-digit login PIN
    transactionPinHash: { type: String, default: null }, // bcrypt hash for 4-digit transaction PIN
    isEmailVerified: { type: Boolean, default: false },
    emailOTP: { type: String },
    emailOTPExpires: { type: Date },
    isPhoneVerified: { type: Boolean, default: false },
    phoneOTP: { type: String },
    phoneOTPExpires: { type: Date },
    walletBalance: { type: Number, default: 0 },
    kyc: {
      status: {
        type: String,
        enum: ["unverified", "pending", "verified", "rejected"],
        default: "unverified",
      },
      bvn: { type: String, default: null },
      bvnVerified: { type: Boolean, default: false },
      idType: {
        type: String,
        enum: ["NIN", "DRIVERS_LICENSE", "PASSPORT", "VOTER_ID", null],
        default: null,
      },
      idImageUrl: { type: String, default: null },
      idVerified: { type: Boolean, default: false },
      notes: { type: String, default: null },
    },
    roles: { type: [String], default: ["user"] },
  },
  { timestamps: true }
);

// Hash transaction PIN and login PIN before saving
userSchema.pre("save", async function (next) {
  if (this.isModified("transactionPinHash") && this.transactionPinHash) {
    this.transactionPinHash = await bcrypt.hash(this.transactionPinHash, 10);
  }
  if (this.isModified("pinHash") && this.pinHash) {
    this.pinHash = await bcrypt.hash(this.pinHash, 10);
  }
  next();
});

module.exports = mongoose.model("User", userSchema);
