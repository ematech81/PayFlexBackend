'use strict';

const mongoose = require('mongoose');

const cacValidationSchema = new mongoose.Schema(
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
    // e.g. 'rc_number' | 'company_name' | 'tin' | 'vrc_share_capital' | etc.
    validationType: {
      type: String,
      required: true,
    },
    // The raw value the user searched (RC number, company name, TIN, VRC code)
    searchParam: {
      type: String,
      required: true,
    },
    // Full response from VAS — stored for history / PDF generation
    result: {
      type: mongoose.Schema.Types.Mixed,
    },
    // Revenue fields
    userPaid:  { type: Number, required: true },
    vasCost:   { type: Number, required: true },
    ourMargin: { type: Number, required: true },

    billingTransactionRef: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CACValidation', cacValidationSchema);
