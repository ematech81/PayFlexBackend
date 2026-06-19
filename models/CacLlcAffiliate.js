'use strict';

const mongoose = require('mongoose');

const shareAllotmentSchema = new mongoose.Schema({
  allottedOrdinaryShares:   { type: Number, default: 0 },
  allottedPreferenceShares: { type: Number, default: 0 },
}, { _id: false });

const cacLlcAffiliateSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    sessionId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'CacLlcSession',
      required: true,
      index:    true,
    },

    affiliateType: {
      type:     String,
      enum:     ['director', 'shareholder', 'secretary', 'witness'],
      required: true,
    },
    affiliateMode: {
      type:    String,
      enum:    ['individual', 'corporate'],
      default: 'individual',
    },
    isShareholder:  { type: Boolean, default: false },
    shareAllotment: shareAllotmentSchema,

    // Raw affiliate payload (images stripped before storage)
    affiliateData: { type: mongoose.Schema.Types.Mixed },

    vasResponse:   { type: mongoose.Schema.Types.Mixed },

    status: {
      type:    String,
      enum:    ['pending', 'registered', 'failed'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CacLlcAffiliate', cacLlcAffiliateSchema);
