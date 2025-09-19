const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true, unique: true },
  passwordHash: { type: String },
  pinHash: { type: String }, // 6-digit login PIN
  transactionPinHash: { type: String }, // 4-digit transaction PIN
  isPhoneVerified: { type: Boolean, default: false },
  phoneOTP: { type: String },
  phoneOTPExpires: { type: Date },
  kyc: { type: String, default: "pending" },
  walletBalance: { type: Number, default: 0 },
  roles: [{ type: String }],
});

// Hash password, login PIN, and transaction PIN before saving
userSchema.pre("save", async function (next) {
  try {
    if (this.isModified("passwordHash") && this.passwordHash) {
      console.log("Hashing passwordHash for phone:", this.phone);
      this.passwordHash = await bcrypt.hash(this.passwordHash, 10);
      console.log("Hashed passwordHash:", this.passwordHash);
    }
    if (this.isModified("pinHash") && this.pinHash) {
      console.log(
        "Hashing pinHash for phone:",
        this.phone,
        "PIN:",
        this.pinHash
      );
      this.pinHash = await bcrypt.hash(this.pinHash, 10);
      console.log("Hashed pinHash:", this.pinHash);
    }
    if (this.isModified("transactionPinHash") && this.transactionPinHash) {
      console.log(
        "Hashing transactionPinHash for phone:",
        this.phone,
        "PIN:",
        this.transactionPinHash
      );
      this.transactionPinHash = await bcrypt.hash(this.transactionPinHash, 10);
      console.log("Hashed transactionPinHash:", this.transactionPinHash);
    }
    next();
  } catch (error) {
    console.error("Error in pre-save hook:", error.message);
    next(error);
  }
});

module.exports = mongoose.model("User", userSchema);
