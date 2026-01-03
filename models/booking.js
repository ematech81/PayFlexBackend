// models/Booking.js
const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema(
  {
    // User Reference
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Booking Reference (Unique)
    bookingReference: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },

    // Booking Status
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled', 'completed', 'refunded'],
      default: 'pending',
      index: true,
    },

    // Trip Details
    tripDetails: {
      provider: {
        name: { type: String, required: true },
        shortName: { type: String, required: true },
        logo: String,
      },
      tripId: { type: Number, required: true },
      tripNo: Number,
      route: { type: String, required: true }, // "Lagos → Owerri"
      origin: { type: String, required: true },
      destination: { type: String, required: true },
      departureTerminal: { type: String, required: true },
      destinationTerminal: { type: String, required: true },
      departureAddress: String,
      destinationAddress: String,
      departureDate: { type: String, required: true }, // "2026-01-15"
      departureTime: { type: String, required: true }, // "06:45"
      vehicle: String, // "2+2, Sprinter Service, AC"
      boardingAt: String,
      orderId: String,
    },

    // Passengers Array
    passengers: [
      {
        seatNumber: { type: Number, required: true },
        title: { 
          type: String, 
          required: true,
          enum: ['Mr', 'Mrs', 'Miss', 'Dr'],
        },
        fullName: { type: String, required: true },
        age: { type: Number, required: true, min: 1, max: 120 },
        gender: { 
          type: String, 
          required: true,
          enum: ['Male', 'Female'],
        },
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
        nextOfKin: { type: String, required: true },
        nextOfKinPhone: { 
          type: String, 
          required: true,
          match: [/^0[789]\d{9}$/, 'Invalid phone number'],
        },
        isPrimary: { type: Boolean, default: false }, // First passenger
      },
    ],

    // Payment Details
    payment: {
      amount: { type: Number, required: true, min: 0 },
      farePerSeat: { type: Number, required: true, min: 0 },
      totalSeats: { type: Number, required: true, min: 1 },
      serviceFee: { type: Number, default: 0 },
      method: { 
        type: String, 
        required: true,
        enum: ['wallet', 'card', 'bank_transfer'],
      },
      transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Transaction',
      },
      paidAt: { type: Date, required: true },
    },

    // Travu API Response (for reference)
    travuBookingId: String,
    travuResponse: mongoose.Schema.Types.Mixed,

    // Cancellation Details
    cancellation: {
      reason: String,
      cancelledAt: Date,
      refundAmount: Number,
      refundStatus: {
        type: String,
        enum: ['pending', 'processed', 'failed'],
      },
    },

    // Metadata
    ipAddress: String,
    userAgent: String,
    deviceInfo: String,
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
bookingSchema.index({ bookingReference: 1 });
bookingSchema.index({ userId: 1, createdAt: -1 });
bookingSchema.index({ status: 1, createdAt: -1 });
bookingSchema.index({ 'tripDetails.departureDate': 1 });
bookingSchema.index({ 'passengers.phone': 1 });

// Generate unique booking reference
bookingSchema.statics.generateBookingReference = function () {
  const prefix = 'BK';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${timestamp}${random}`;
};

// Virtual for total passengers
bookingSchema.virtual('totalPassengers').get(function () {
  return this.passengers.length;
});

// Method to check if booking can be cancelled
bookingSchema.methods.canBeCancelled = function () {
  if (this.status !== 'confirmed') return false;
  
  // Check if departure date is in the future (at least 2 hours from now)
  const departureDateTime = new Date(`${this.tripDetails.departureDate}T${this.tripDetails.departureTime}`);
  const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  
  return departureDateTime > twoHoursFromNow;
};

module.exports = mongoose.model('Booking', bookingSchema);