// models/PassengerProfile.js
const mongoose = require('mongoose');

const passengerProfileSchema = new mongoose.Schema(
  {
    // User Reference
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Saved Profiles
    profiles: [
      {
        fullName: { type: String, required: true },
        phone: { 
          type: String, 
          required: true,
          match: [/^0[789]\d{9}$/, 'Invalid phone number'],
        },
        email: {
          type: String,
          lowercase: true,
          trim: true,
        },
        age: { type: Number, min: 1, max: 120 },
        gender: { 
          type: String,
          enum: ['Male', 'Female'],
        },
        title: {
          type: String,
          enum: ['Mr', 'Mrs', 'Miss', 'Dr'],
        },
        nextOfKin: String,
        nextOfKinPhone: {
          type: String,
          match: [/^0[789]\d{9}$/, 'Invalid phone number'],
        },
        lastUsed: { type: Date, default: Date.now },
        timesUsed: { type: Number, default: 1 },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Index for fast lookups
passengerProfileSchema.index({ userId: 1 });
passengerProfileSchema.index({ 'profiles.phone': 1 });

// Method to add or update profile
passengerProfileSchema.methods.addOrUpdateProfile = function (profileData) {
  const existingIndex = this.profiles.findIndex(
    (p) => p.phone === profileData.phone
  );

  if (existingIndex !== -1) {
    // Update existing profile
    this.profiles[existingIndex] = {
      ...this.profiles[existingIndex].toObject(),
      ...profileData,
      lastUsed: Date.now(),
      timesUsed: this.profiles[existingIndex].timesUsed + 1,
    };
  } else {
    // Add new profile
    this.profiles.push({
      ...profileData,
      lastUsed: Date.now(),
      timesUsed: 1,
    });
  }

  // Keep only last 10 profiles (sorted by lastUsed)
  this.profiles.sort((a, b) => b.lastUsed - a.lastUsed);
  if (this.profiles.length > 10) {
    this.profiles = this.profiles.slice(0, 10);
  }
};

module.exports = mongoose.model('PassengerProfile', passengerProfileSchema);