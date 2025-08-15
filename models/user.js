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

// const mongoose = require("mongoose");

// const userSchema = new mongoose.Schema(
//   {
//     firstName: { type: String, trim: true },
//     lastName: { type: String, trim: true },

//     email: {
//       type: String,
//       unique: true,
//       sparse: true,
//       lowercase: true,
//       trim: true,
//       required: true, // ensure email is always collected
//     },

//     phone: {
//       type: String,
//       unique: true,
//       sparse: true,
//       trim: true,
//       default: null, // allow phone to be added later
//     },

//     passwordHash: { type: String, required: true }, // bcrypt hash
//     pinHash: { type: String, default: null }, // bcrypt hash (4–6 digits)

//     // Verification flags
//     isEmailVerified: { type: Boolean, default: false },
//     isPhoneVerified: { type: Boolean, default: false },

//     // OTPs for verification
//     emailOTP: { type: String },
//     emailOTPExpires: { type: Date },

//     phoneOTP: { type: String },
//     phoneOTPExpires: { type: Date },

//     // Wallet (for VTpass & other payments)
//     walletBalance: { type: Number, default: 0 },

//     // Transaction limits (good for compliance)
//     dailyTransactionLimit: { type: Number, default: 50000 }, // NGN

//     // KYC section
//     kyc: {
//       status: {
//         type: String,
//         enum: ["unverified", "pending", "verified", "rejected"],
//         default: "unverified",
//       },
//       bvn: { type: String, default: null },
//       bvnVerified: { type: Boolean, default: false },
//       idType: {
//         type: String,
//         enum: ["NIN", "DRIVERS_LICENSE", "PASSPORT", "VOTER_ID", null],
//         default: null,
//       },
//       idImageUrl: { type: String, default: null }, // Cloud URL or local path
//       idVerified: { type: Boolean, default: false },
//       notes: { type: String, default: null },
//     },

//     // Login security
//     lastLogin: { type: Date, default: null },
//     failedLoginAttempts: { type: Number, default: 0 },
//     accountLockedUntil: { type: Date, default: null },

//     roles: { type: [String], default: ["user"] },
//   },
//   { timestamps: true }
// );

// module.exports = mongoose.model("User", userSchema);
