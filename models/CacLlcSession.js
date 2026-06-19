'use strict';

const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
  state:  { type: String },
  lga:    { type: String },
  city:   { type: String },
  street: { type: String },
}, { _id: false });

const cacLlcSessionSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },

    // ── Step 1: Name Reservation ──────────────────────────────────────────────
    proposedName:      { type: String, required: true, trim: true },
    companyType:       { type: String, trim: true },
    reservationCode:   { type: String },
    reservationExpiry: { type: Date },

    // ── Step 2/3: Memorandum Objects ──────────────────────────────────────────
    objectsOfMem:        { type: [String], default: [] },
    minimumShareCapital: { type: Number,  default: null },
    objectsAnalysed:     { type: Boolean, default: false },
    analysisResult:      { type: mongoose.Schema.Types.Mixed },

    // ── Step 4: Company Creation ──────────────────────────────────────────────
    vasTransactionRef:        { type: String, index: true },
    natureOfBusinessCategory: { type: String },
    natureOfBusiness:         { type: String },
    companyDetails:           { type: mongoose.Schema.Types.Mixed },

    // ── Step 5: Shares ────────────────────────────────────────────────────────
    ordinaryIssuedShare:   { type: Number },
    pricePerShare:         { type: Number, default: 1 },
    preferenceIssuedShare: { type: Number, default: 0 },
    shareCapital:          { type: Number },
    sharesRegistered:      { type: Boolean, default: false },

    // ── Step 6: Affiliates ────────────────────────────────────────────────────
    affiliateCount:               { type: Number, default: 0 },
    totalAllocatedOrdinaryShares: { type: Number, default: 0 },

    // ── Status ────────────────────────────────────────────────────────────────
    // Terminal states post-Step 6: 'affiliates_complete'.
    // Steps 7–8 (PSC, Validate/Pay/Submit) pending docs — add statuses there.
    status: {
      type: String,
      enum: [
        'name_reserved',
        'memorandum_done',
        'company_created',
        'shares_registered',
        'affiliates_complete',
        'failed',
        'cancelled',
      ],
      default: 'name_reserved',
      index:   true,
    },

    failureReason: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CacLlcSession', cacLlcSessionSchema);
