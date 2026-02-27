// models/FlightBooking.js
const mongoose = require('mongoose');

// ============================================
// FLIGHT BOOKING SCHEMA
// ============================================

const flightBookingSchema = new mongoose.Schema(
  {
    // ============================================
    // USER & REFERENCE
    // ============================================
    
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    bookingReference: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      // Format: FL20260210ABC123
    },

    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled', 'completed', 'refunded'],
      default: 'pending',
      index: true,
    },

    // ============================================
    // AMADEUS IDENTIFIERS
    // ============================================

    amadeusOrderId: {
      type: String,
      index: true,
    },

    pnr: {
      type: String, // Passenger Name Record
      index: true,
    },

    // ============================================
    // FLIGHT OFFER DETAILS
    // ============================================

    flightOffer: {
      offerId: String,
      source: String, // GDS
      instantTicketingRequired: Boolean,
      lastTicketingDate: String,
      numberOfBookableSeats: Number,
      oneWay: Boolean,
      
      // Validating airline
      validatingAirlineCodes: [String],
    },

    // ============================================
    // ITINERARIES (Outbound + Return if applicable)
    // ============================================

    itineraries: [
      {
        duration: String, // PT32H15M
        
        segments: [
          {
            segmentId: String,
            
            // Departure
            departure: {
              iataCode: { type: String, required: true },
              terminal: String,
              at: { type: String, required: true }, // DateTime
            },

            // Arrival
            arrival: {
              iataCode: { type: String, required: true },
              terminal: String,
              at: { type: String, required: true }, // DateTime
            },

            // Flight Info
            carrierCode: { type: String, required: true }, // Airline code
            number: { type: String, required: true }, // Flight number
            
            aircraft: {
              code: String, // 789, 788, etc.
            },

            operating: {
              carrierCode: String, // Operating carrier if codeshare
            },

            duration: String, // PT8H15M
            numberOfStops: { type: Number, default: 0 },
            blacklistedInEU: Boolean,
          },
        ],
      },
    ],

    // ============================================
    // PRICING
    // ============================================

    price: {
      currency: { type: String, required: true }, // EUR, USD, NGN
      total: { type: String, required: true },
      base: { type: String, required: true },
      
      fees: [
        {
          amount: String,
          type: String, // SUPPLIER, TICKETING
        },
      ],

      grandTotal: { type: String, required: true },
    },

    pricingOptions: {
      fareType: [String], // PUBLISHED
      includedCheckedBagsOnly: Boolean,
    },

    // ============================================
    // PASSENGERS (TRAVELERS)
    // ============================================

    travelers: [
      {
        travelerId: { type: String, required: true },
        
        // Personal Info
        title: {
          type: String,
          enum: ['MR', 'MRS', 'MS', 'MISS', 'DR'],
          required: true,
        },
        
        name: {
          firstName: { type: String, required: true },
          lastName: { type: String, required: true },
          middleName: String,
        },

        dateOfBirth: { type: String, required: true }, // YYYY-MM-DD
        gender: {
          type: String,
          enum: ['MALE', 'FEMALE'],
          required: true,
        },

        // Contact
        contact: {
          emailAddress: String,
          phones: [
            {
              deviceType: String, // MOBILE, LANDLINE
              countryCallingCode: String,
              number: String,
            },
          ],
        },

        // Travel Documents
        documents: [
          {
            documentType: String, // PASSPORT, VISA, ID_CARD
            number: String,
            expiryDate: String,
            issuanceCountry: String,
            nationality: String,
            holder: Boolean,
          },
        ],

        // Emergency Contact
        emergencyContact: {
          fullName: String,
          phone: String,
        },

        // Pricing for this traveler
        travelerType: {
          type: String,
          enum: ['ADULT', 'CHILD', 'HELD_INFANT', 'SEATED_INFANT', 'SENIOR'],
          required: true,
        },

        fareOption: String, // STANDARD, BASIC, etc.

        price: {
          currency: String,
          total: String,
          base: String,
        },

        // Fare details per segment
        fareDetailsBySegment: [
          {
            segmentId: String,
            cabin: String, // ECONOMY, PREMIUM_ECONOMY, BUSINESS, FIRST
            fareBasis: String,
            class: String, // Booking class
            
            includedCheckedBags: {
              quantity: Number,
              weight: Number,
              weightUnit: String, // KG or LB
            },
          },
        ],
      },
    ],

    // ============================================
    // CONTACT INFORMATION
    // ============================================

    contacts: [
      {
        addresseeName: {
          firstName: String,
          lastName: String,
        },
        purpose: String, // STANDARD, INVOICE
        phones: [
          {
            deviceType: String,
            countryCallingCode: String,
            number: String,
          },
        ],
        emailAddress: String,
      },
    ],

    // ============================================
    // PAYMENT DETAILS
    // ============================================

    payment: {
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, required: true },
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

    // ============================================
    // TICKETS
    // ============================================

    tickets: [
      {
        travelerId: String,
        ticketNumber: String,
        issuedAt: Date,
      },
    ],

    // ============================================
    // CANCELLATION DETAILS
    // ============================================

    cancellation: {
      reason: String,
      cancelledAt: Date,
      cancelledBy: {
        type: String,
        enum: ['user', 'admin', 'airline'],
      },
      refundAmount: Number,
      refundStatus: {
        type: String,
        enum: ['pending', 'processed', 'failed'],
      },
      cancellationFee: Number,
    },

    // ============================================
    // METADATA
    // ============================================

    remarks: {
      general: [String],
      special: [String], // Special requests (meal, wheelchair, etc.)
    },

    ipAddress: String,
    userAgent: String,
    deviceInfo: String,
  },
  {
    timestamps: true,
  }
);

// ============================================
// INDEXES
// ============================================

flightBookingSchema.index({ bookingReference: 1 });
flightBookingSchema.index({ userId: 1, createdAt: -1 });
flightBookingSchema.index({ status: 1, createdAt: -1 });
flightBookingSchema.index({ amadeusOrderId: 1 });
flightBookingSchema.index({ pnr: 1 });
flightBookingSchema.index({ 'itineraries.segments.departure.iataCode': 1 });
flightBookingSchema.index({ 'itineraries.segments.arrival.iataCode': 1 });
flightBookingSchema.index({ 'itineraries.segments.departure.at': 1 });

// ============================================
// STATIC METHODS
// ============================================

/**
 * Generate unique booking reference
 * Format: FL20260210ABC123
 */
flightBookingSchema.statics.generateBookingReference = function () {
  const prefix = 'FL';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${timestamp}${random}`;
};

// ============================================
// VIRTUALS
// ============================================

/**
 * Get total passengers
 */
flightBookingSchema.virtual('totalPassengers').get(function () {
  return this.travelers.length;
});

/**
 * Get departure info
 */
flightBookingSchema.virtual('departure').get(function () {
  if (this.itineraries.length > 0 && this.itineraries[0].segments.length > 0) {
    const firstSegment = this.itineraries[0].segments[0];
    return {
      airport: firstSegment.departure.iataCode,
      dateTime: firstSegment.departure.at,
      terminal: firstSegment.departure.terminal,
    };
  }
  return null;
});

/**
 * Get arrival info
 */
flightBookingSchema.virtual('arrival').get(function () {
  if (this.itineraries.length > 0) {
    const lastItinerary = this.itineraries[this.itineraries.length - 1];
    const lastSegment = lastItinerary.segments[lastItinerary.segments.length - 1];
    return {
      airport: lastSegment.arrival.iataCode,
      dateTime: lastSegment.arrival.at,
      terminal: lastSegment.arrival.terminal,
    };
  }
  return null;
});

/**
 * Check if round trip
 */
flightBookingSchema.virtual('isRoundTrip').get(function () {
  return this.itineraries.length > 1;
});

// ============================================
// INSTANCE METHODS
// ============================================

/**
 * Check if booking can be cancelled
 */
flightBookingSchema.methods.canBeCancelled = function () {
  if (this.status !== 'confirmed') return false;

  // Check if departure is at least 24 hours from now
  if (this.itineraries.length > 0 && this.itineraries[0].segments.length > 0) {
    const departureTime = new Date(this.itineraries[0].segments[0].departure.at);
    const now = new Date();
    const hoursUntilDeparture = (departureTime - now) / (1000 * 60 * 60);

    return hoursUntilDeparture >= 24;
  }

  return false;
};

/**
 * Get flight route summary
 */
flightBookingSchema.methods.getRouteSummary = function () {
  if (this.itineraries.length === 0) return '';

  const outbound = this.itineraries[0].segments;
  const origin = outbound[0].departure.iataCode;
  const destination = outbound[outbound.length - 1].arrival.iataCode;

  if (this.isRoundTrip) {
    return `${origin} ⇄ ${destination}`;
  } else {
    return `${origin} → ${destination}`;
  }
};

/**
 * Get total duration
 */
flightBookingSchema.methods.getTotalDuration = function () {
  return this.itineraries.reduce((total, itinerary) => {
    return total + this.parseDuration(itinerary.duration);
  }, 0);
};

/**
 * Parse ISO 8601 duration to minutes
 */
flightBookingSchema.methods.parseDuration = function (duration) {
  // PT32H15M -> 32 hours 15 minutes
  const matches = duration.match(/PT(\d+H)?(\d+M)?/);
  if (!matches) return 0;

  const hours = matches[1] ? parseInt(matches[1]) : 0;
  const minutes = matches[2] ? parseInt(matches[2]) : 0;

  return hours * 60 + minutes;
};




module.exports = mongoose.models.FlightBooking || mongoose.model("FlightBooking", flightBookingSchema);