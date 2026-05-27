'use strict';

const mongoose = require('mongoose');

const bettingTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
      required: true,
    },

    // Our idempotency reference — format: payflex-bet-<uuid>
    ref: {
      type:     String,
      required: true,
      unique:   true,
    },

    // Reference returned by VTU Africa on success
    vtuAfricaReferenceId: { type: String },

    // Lowercase service code, e.g. "bet9ja", "betking"
    bettingPlatform: {
      type:      String,
      required:  true,
      lowercase: true,
      index:     true,
    },

    // Display name for UI, e.g. "Bet9ja"
    bettingPlatformDisplay: { type: String },

    // The bet account user ID supplied by the PayFlex user
    customerId: { type: String, required: true },

    // Customer name captured at verification step — shown on confirmation screen
    customerName: { type: String },

    // Amount the user wants credited to their betting wallet
    requestAmount: { type: Number, required: true },

    // VTU Africa's service charge (from `Charge` field in response).
    // Formula is not yet confirmed — captured per-transaction for later analysis.
    vtuAfricaCharge: { type: Number, default: 0 },

    // requestAmount + vtuAfricaCharge, as returned by VTU Africa
    amountCharged: { type: Number, default: 0 },

    // What we actually debited from the user's wallet
    // (amountCharged + our markup; markup is 0 at launch per Decision 7)
    totalCharged: { type: Number, required: true },

    // Commission earned per transaction (from VTU Africa `comi` field).
    // Internal revenue metric — NEVER exposed in user-facing API responses.
    vtuAfricaCommission: { type: Number, default: 0 },

    // ── Revenue tracking (Pricing Service) ────────────────────────────────
    provider:            { type: String, default: 'vtu-africa' },
    userPaid:            { type: Number, default: 0 },  // amount + serviceFee + recipientFee
    providerCost:        { type: Number, default: 0 },  // amount + vtuFlatFee (merchant wallet debit)
    providerFee:         { type: Number, default: 0 },  // VTU Africa flat fee (₦20)
    recipientFee:        { type: Number, default: 0 },
    ourMargin:           { type: Number, default: 0 },
    marginType:          { type: String, default: 'service_fee' },
    forSomeoneElse:      { type: Boolean, default: false },
    pricingConfigVersion:{ type: String },

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

// Reconciliation job queries
bettingTransactionSchema.index({ status: 1, createdAt: 1 });
// User history queries
bettingTransactionSchema.index({ userId: 1, createdAt: -1 });
// Platform-level analytics
bettingTransactionSchema.index({ bettingPlatform: 1, createdAt: -1 });

bettingTransactionSchema.pre('save', function (next) {
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
  mongoose.models.BettingTransaction ||
  mongoose.model('BettingTransaction', bettingTransactionSchema);
