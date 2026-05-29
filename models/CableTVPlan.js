'use strict';

const mongoose = require('mongoose');

const cableTVPlanSchema = new mongoose.Schema(
  {
    provider:       { type: String, required: true, enum: ['dstv', 'gotv', 'startimes', 'showmax'] },
    variationCode:  { type: String, required: true },   // 'gotv_jinja', 'dstv_padi' …
    planName:       { type: String, required: true },   // display name
    costPrice:      { type: Number, required: true, min: 0 },
    billingPeriod:  { type: String, required: true, enum: ['daily', 'weekly', 'monthly', '3months', 'yearly'] },
    status:         { type: String, enum: ['Active', 'Disabled'], default: 'Active' },
    vtuProvider:    { type: String, default: 'vtuafrica' },
  },
  { timestamps: true }
);

cableTVPlanSchema.index({ vtuProvider: 1, variationCode: 1 }, { unique: true });
cableTVPlanSchema.index({ provider: 1, status: 1 });

module.exports = mongoose.models.CableTVPlan || mongoose.model('CableTVPlan', cableTVPlanSchema);
