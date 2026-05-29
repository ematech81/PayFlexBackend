'use strict';

/**
 * Cable TV Plan Seed Script
 *
 * Upserts GOtv, DStv, and Startimes plans into MongoDB.
 * Daily plans (cost ₦0) are excluded per spec.
 * Safe to re-run — uses upsert so it won't duplicate.
 *
 * Usage:
 *   node seeds/cabletvplans.js
 */

require('dotenv').config();
const mongoose   = require('mongoose');
const CableTVPlan = require('../models/CableTVPlan');

const PLANS = [
  // ── GOtv ──────────────────────────────────────────────────────────────────
  { provider: 'gotv', variationCode: 'gotv_smallie',          planName: 'GOtv Smallie',          costPrice: 1900,  billingPeriod: 'monthly'  },
  { provider: 'gotv', variationCode: 'gotv_smallie_3months',  planName: 'GOtv Smallie 3 Months', costPrice: 5100,  billingPeriod: '3months'  },
  { provider: 'gotv', variationCode: 'gotv_smallie_1year',    planName: 'GOtv Smallie 1 Year',   costPrice: 15000, billingPeriod: 'yearly'   },
  { provider: 'gotv', variationCode: 'gotv_jinja',            planName: 'GOtv Jinja',            costPrice: 3900,  billingPeriod: 'monthly'  },
  { provider: 'gotv', variationCode: 'gotv_jolli',            planName: 'GOtv Jolli',            costPrice: 5800,  billingPeriod: 'monthly'  },
  { provider: 'gotv', variationCode: 'gotv_max',              planName: 'GOtv Max',              costPrice: 8500,  billingPeriod: 'monthly'  },

  // ── DStv ──────────────────────────────────────────────────────────────────
  { provider: 'dstv', variationCode: 'dstv_padi',             planName: 'DStv Padi',             costPrice: 4400,  billingPeriod: 'monthly'  },
  { provider: 'dstv', variationCode: 'dstv_yanga',            planName: 'DStv Yanga',            costPrice: 6000,  billingPeriod: 'monthly'  },
  { provider: 'dstv', variationCode: 'dstv_confam',           planName: 'DStv Confam',           costPrice: 11000, billingPeriod: 'monthly'  },
  { provider: 'dstv', variationCode: 'dstv_compact',          planName: 'DStv Compact',          costPrice: 19000, billingPeriod: 'monthly'  },
  { provider: 'dstv', variationCode: 'dstv_compact_plus',     planName: 'DStv Compact Plus',     costPrice: 30000, billingPeriod: 'monthly'  },
  { provider: 'dstv', variationCode: 'dstv_premium',          planName: 'DStv Premium',          costPrice: 44500, billingPeriod: 'monthly'  },
  { provider: 'dstv', variationCode: 'dstv_asia',             planName: 'DStv Asia',             costPrice: 14900, billingPeriod: 'monthly'  },
  { provider: 'dstv', variationCode: 'dstv_premium_french',   planName: 'DStv Premium French',   costPrice: 69000, billingPeriod: 'monthly'  },

  // ── Startimes (weekly + monthly only — daily plans excluded per spec) ──────
  { provider: 'startimes', variationCode: 'startimes_nova',    planName: 'Startimes Nova',    costPrice: 1900,  billingPeriod: 'monthly' },
  { provider: 'startimes', variationCode: 'startimes_basic',   planName: 'Startimes Basic',   costPrice: 3700,  billingPeriod: 'monthly' },
  { provider: 'startimes', variationCode: 'startimes_smart',   planName: 'Startimes Smart',   costPrice: 4700,  billingPeriod: 'monthly' },
  { provider: 'startimes', variationCode: 'startimes_classic', planName: 'Startimes Classic', costPrice: 5500,  billingPeriod: 'monthly' },
  { provider: 'startimes', variationCode: 'startimes_super',   planName: 'Startimes Super',   costPrice: 9000,  billingPeriod: 'monthly' },
  // Weekly plans
  { provider: 'startimes', variationCode: 'startimes_nova_weekly',    planName: 'Startimes Nova (Weekly)',    costPrice: 600,  billingPeriod: 'weekly' },
  { provider: 'startimes', variationCode: 'startimes_basic_weekly',   planName: 'Startimes Basic (Weekly)',   costPrice: 1250, billingPeriod: 'weekly' },
  { provider: 'startimes', variationCode: 'startimes_smart_weekly',   planName: 'Startimes Smart (Weekly)',   costPrice: 1550, billingPeriod: 'weekly' },
  { provider: 'startimes', variationCode: 'startimes_classic_weekly', planName: 'Startimes Classic (Weekly)', costPrice: 1900, billingPeriod: 'weekly' },
  { provider: 'startimes', variationCode: 'startimes_super_weekly',   planName: 'Startimes Super (Weekly)',   costPrice: 3000, billingPeriod: 'weekly' },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  let upserted = 0;
  let errors   = 0;

  for (const plan of PLANS) {
    try {
      await CableTVPlan.findOneAndUpdate(
        { vtuProvider: 'vtuafrica', variationCode: plan.variationCode },
        { ...plan, status: 'Active', vtuProvider: 'vtuafrica' },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      upserted++;
    } catch (err) {
      console.error(`Failed to upsert ${plan.variationCode}:`, err.message);
      errors++;
    }
  }

  console.log(`\nDone. ${upserted} plans upserted, ${errors} errors.`);
  console.log(`Total plans: GOtv (6) + DStv (8) + Startimes monthly (5) + Startimes weekly (5) = ${PLANS.length}`);
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
