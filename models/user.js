const mongoose = require("mongoose");

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

    passwordHash: { type: String, required: true }, // bcrypt hash
    pinHash: { type: String, default: null }, // bcrypt hash (4–6 digits)

    // Email verification
    isEmailVerified: { type: Boolean, default: false },
    emailOTP: { type: String },
    emailOTPExpires: { type: Date },

    // Phone verification
    isPhoneVerified: { type: Boolean, default: false },
    phoneOTP: { type: String },
    phoneOTPExpires: { type: Date },

    // Wallet
    walletBalance: { type: Number, default: 0 },

    // KYC
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
      idImageUrl: { type: String, default: null }, // local path or cloud URL
      idVerified: { type: Boolean, default: false },
      notes: { type: String, default: null },
    },

    roles: { type: [String], default: ["user"] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
