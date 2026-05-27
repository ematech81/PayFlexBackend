'use strict';

const mongoose = require('mongoose');

// ─── Plan definitions ─────────────────────────────────────────────────────────
// Stored as a schema enum so the model is self-documenting.
// Actual pricing and feature gates live in pricingService (not yet built).
const PLAN_TYPES = ['free', 'basic', 'pro', 'business'];
const BILLING_CYCLES = ['monthly', 'annual'];

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      unique:   true, // one active subscription per user
    },

    plan: {
      type:    String,
      enum:    PLAN_TYPES,
      default: 'free',
    },

    billingCycle: {
      type: String,
      enum: BILLING_CYCLES,
    },

    status: {
      type:    String,
      enum:    ['active', 'cancelled', 'expired', 'past_due'],
      default: 'active',
    },

    // Price the user was charged at subscription start (NGN). 0 for free plan.
    pricePaid: { type: Number, default: 0 },

    // When the current billing period ends
    currentPeriodEnd: { type: Date },

    // When the user cancelled (null if still active)
    cancelledAt: { type: Date },

    // Stripe / Paystack subscription ID when payment integration is added
    externalSubscriptionId: { type: String },
  },
  { timestamps: true }
);

subscriptionSchema.index({ userId: 1 });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

module.exports =
  mongoose.models.Subscription ||
  mongoose.model('Subscription', subscriptionSchema);
