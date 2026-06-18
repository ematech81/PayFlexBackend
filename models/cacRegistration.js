'use strict';

const mongoose = require('mongoose');

const querySchema = new mongoose.Schema({
  reason:  { type: String },
  comment: { type: String },
}, { _id: false });

const cacRegistrationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    transactionRef: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    registrationType: {
      type: String,
      enum: ['business_name', 'llc'],
      required: true,
    },
    proposedName: {
      type: String,
      required: true,
    },
    // Full sanitised request body sent to VAS (no secrets)
    registrationData: {
      type: mongoose.Schema.Types.Mixed,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'queried', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    // transactionRef returned by VAS API on submission (VAS20240613... format)
    // used for polling /api/vas/portal/user/status/{vasTransactionRef}
    vasTransactionRef: { type: String, index: true },

    // Populated by webhook after CAC approval
    rcNumber:       { type: String },
    tin:            { type: String },
    certificateUrl: { type: String },

    // Populated when status === 'queried'
    queries: [querySchema],

    priorityService: { type: Boolean, default: false },

    // Revenue fields — recorded at transaction time, never recomputed
    userPaid:  { type: Number, required: true },
    vasCost:   { type: Number, required: true },
    ourMargin: { type: Number, required: true },

    // Webhook tracking
    webhookReceived:   { type: Boolean, default: false },
    webhookReceivedAt: { type: Date },

    completedAt: { type: Date },

    // Links to the billing Transaction record
    billingTransactionRef: { type: String },
  },
  { timestamps: true }
);

// Auto-set completedAt when status moves to approved/failed/cancelled
cacRegistrationSchema.pre('save', function (next) {
  if (this.isModified('status') && ['approved', 'failed', 'cancelled'].includes(this.status)) {
    if (!this.completedAt) this.completedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('CACRegistration', cacRegistrationSchema);
