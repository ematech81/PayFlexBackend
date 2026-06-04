'use strict';

const mongoose = require('mongoose');

const merpiTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['bus_ticket', 'event_ticket', 'cinema_ticket'],
      required: true,
    },
    reference: {
      type: String,
      unique: true,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    ourMargin: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },
    bookingDetails: {
      type: mongoose.Schema.Types.Mixed,
    },
    walletDeducted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

merpiTransactionSchema.index({ userId: 1, createdAt: -1 });
merpiTransactionSchema.index({ reference: 1 });

module.exports =
  mongoose.models.MerpiTransaction ||
  mongoose.model('MerpiTransaction', merpiTransactionSchema);
