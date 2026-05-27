'use strict';

const mongoose = require('mongoose');

const pinSchema = new mongoose.Schema(
  { pin: String, serial: String },
  { _id: false }
);

const examPinTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
      required: true,
    },

    // Our idempotency reference — format: payflex-exam-<uuid>
    ref: {
      type:     String,
      required: true,
      unique:   true,
    },

    // Reference returned by VTU Africa on success
    vtuAfricaReferenceId: { type: String },

    examBody: {
      type:      String,
      required:  true,
      enum:      ['waec', 'neco', 'nabteb', 'jamb'],
      lowercase: true,
    },

    // "1", "2", "3" per VTU Africa product table
    productCode: { type: String, required: true },

    // Human-readable, e.g. "WAEC Result Checker PIN"
    productName: { type: String },

    quantity: {
      type:     Number,
      required: true,
      min:      1,
      max:      50,
    },

    unitPrice:     { type: Number, default: 0 }, // per-pin cost price from VTU Africa
    amountCharged: { type: Number, default: 0 }, // actual amount VTU Africa charged us
    totalCharged:  { type: Number, required: true }, // what we debited from the user's wallet

    // Commission earned per transaction (from VTU Africa `comi` field).
    // Internal revenue metric — NEVER exposed in user-facing API responses.
    vtuAfricaCommission: { type: Number, default: 0 },

    // ── Revenue tracking (Pricing Service) ────────────────────────────────
    provider:            { type: String, default: 'vtu-africa' },
    userPaid:            { type: Number, default: 0 },  // sellingPrice * qty + recipientFee
    providerCost:        { type: Number, default: 0 },  // ourCost * qty
    providerFee:         { type: Number, default: 0 },
    recipientFee:        { type: Number, default: 0 },
    ourMargin:           { type: Number, default: 0 },
    marginType:          { type: String, default: 'markup' },
    forSomeoneElse:      { type: Boolean, default: false },
    pricingConfigVersion:{ type: String },

    // Populated on success. Empty array while status is "pending" (e.g. JAMB async delivery).
    pins: [pinSchema],

    // JAMB-only fields
    jambProfileCode:   { type: String },
    jambCandidateName: { type: String },
    recipientPhone:    { type: String },
    recipientEmail:    { type: String },

    status: {
      type:    String,
      enum:    ['pending', 'success', 'failed', 'refunded'],
      default: 'pending',
      index:   true,
    },

    errorCode:    { type: String },
    errorMessage: { type: String },

    // Link to the wallet debit entry in the shared Transaction collection
    walletDebitTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Transaction',
    },

    completedAt: { type: Date },
  },
  { timestamps: true }
);

// Reconciliation job queries: pending transactions older than N minutes
examPinTransactionSchema.index({ status: 1, createdAt: 1 });
// User history queries
examPinTransactionSchema.index({ userId: 1, createdAt: -1 });

examPinTransactionSchema.pre('save', function (next) {
  if (
    this.isModified('status') &&
    this.status === 'success' &&
    !this.completedAt
  ) {
    this.completedAt = new Date();
  }
  next();
});

module.exports =
  mongoose.models.ExamPinTransaction ||
  mongoose.model('ExamPinTransaction', examPinTransactionSchema);
