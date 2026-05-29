'use strict';

const mongoose = require('mongoose');

const dataPlanSchema = new mongoose.Schema(
  {
    network:      { type: String, required: true, enum: ['MTN', 'Airtel', 'GLO', '9Mobile'] },
    serviceType:  { type: String, required: true },                  // SME | Corporate | Gifting | Awoof
    serviceCode:  { type: String, required: true },                  // MTNSME | AIRTELCG | GLOGIFT …
    dataPlanCode: { type: String, required: true },                  // 1000 | 500W | 1000D …
    description:  { type: String, required: true },                  // "MTN SME Data"
    size:         { type: String, required: true },                  // "1GB"
    validity:     { type: String, required: true },                  // "30 Days"
    costPrice:    { type: Number, required: true, min: 0 },          // what VTU Africa charges (NGN)
    status:       { type: String, enum: ['Active', 'Disabled'], default: 'Active' },
    provider:     { type: String, default: 'vtuafrica' },
  },
  { timestamps: true }
);

// Unique per provider+service+code combination
dataPlanSchema.index({ provider: 1, serviceCode: 1, dataPlanCode: 1 }, { unique: true });
dataPlanSchema.index({ network: 1, status: 1 });

module.exports = mongoose.models.DataPlan || mongoose.model('DataPlan', dataPlanSchema);
