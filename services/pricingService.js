'use strict';

/**
 * PayFlex Pricing Service
 *
 * Single source of truth for all revenue calculations.
 * Pure functions only — no API calls, no DB access.
 * All values are env-overridable; restarts apply new prices to new transactions only.
 *
 * Provider map:
 *   vtpass     — Airtime, Data, Cable TV, Electricity
 *   vtu-africa — Exam PINs, Betting funding (Airtime2Cash deferred)
 *   kora-pay   — Wallet top-up (collection side)
 */

const crypto = require('crypto');

// ─── Pricing Configuration ────────────────────────────────────────────────────

const config = {
  airtime: {
    mtn:      parseFloat(process.env.PRICING_AIRTIME_MARKUP_MTN)     || 0.03,
    airtel:   parseFloat(process.env.PRICING_AIRTIME_MARKUP_AIRTEL)  || 0.035,
    glo:      parseFloat(process.env.PRICING_AIRTIME_MARKUP_GLO)     || 0.03,
    '9mobile': parseFloat(process.env.PRICING_AIRTIME_MARKUP_9MOBILE) || 0.03,
  },
  data: {
    markup:    parseFloat(process.env.PRICING_DATA_MARKUP)    || 0.025,
    minMargin: parseInt(process.env.PRICING_DATA_MIN_MARGIN)  || 20,
  },
  cable: {
    markup:    parseFloat(process.env.PRICING_CABLE_MARKUP)    || 0.02,
    minMargin: parseInt(process.env.PRICING_CABLE_MIN_MARGIN)  || 50,
  },
  electricity: {
    markup:    parseFloat(process.env.PRICING_ELECTRICITY_MARKUP)    || 0.015,
    minMargin: parseInt(process.env.PRICING_ELECTRICITY_MIN_MARGIN)  || 50,
  },
  // Airtime2Cash: deduction rates shown to users (Normal User tier from VTU Africa docs).
  // Portal Owner cost rates: MTN 25%, GLO 40%, Airtel 30%, 9mobile 40%.
  // Spread between user rate and portal owner cost is our margin.
  airtimeCash: {
    mtn:      parseFloat(process.env.PRICING_A2C_DEDUCTION_MTN)     || 0.30,
    glo:      parseFloat(process.env.PRICING_A2C_DEDUCTION_GLO)     || 0.45,
    airtel:   parseFloat(process.env.PRICING_A2C_DEDUCTION_AIRTEL)  || 0.35,
    '9mobile': parseFloat(process.env.PRICING_A2C_DEDUCTION_9MOBILE) || 0.45,
    // Portal Owner (our actual cost from VTU Africa)
    costs: { mtn: 0.25, glo: 0.40, airtel: 0.30, '9mobile': 0.40 },
  },
  examPins: {
    // User-facing selling prices (env-overridable)
    waec_1:   parseInt(process.env.PRICING_EXAM_WAEC_RESULT_CHECKER)   || 5500,
    waec_2:   parseInt(process.env.PRICING_EXAM_WAEC_GCE)              || 25000,
    waec_3:   parseInt(process.env.PRICING_EXAM_WAEC_VERIFICATION)     || 4500,
    neco_1:   parseInt(process.env.PRICING_EXAM_NECO_RESULT_TOKEN)     || 2500,
    neco_2:   parseInt(process.env.PRICING_EXAM_NECO_GCE)              || 0,
    nabteb_1: parseInt(process.env.PRICING_EXAM_NABTEB_RESULT_CHECKER) || 1500,
    nabteb_2: parseInt(process.env.PRICING_EXAM_NABTEB_GCE)            || 0,
    jamb_1:   parseInt(process.env.PRICING_EXAM_JAMB_UTME)             || 7700,
    jamb_2:   parseInt(process.env.PRICING_EXAM_JAMB_DIRECT_ENTRY)     || 6200,
    // VTU Africa Portal Owner costs (confirmed from VTU Africa pricing page)
    costs: {
      waec_1:   5000,
      waec_2:   24000,
      waec_3:   4000,
      neco_1:   2100,
      neco_2:   0,    // not yet available from VTU Africa
      nabteb_1: 1200,
      nabteb_2: 0,    // not yet available from VTU Africa
      jamb_1:   7150,
      jamb_2:   5650,
    },
    // neco_2 and nabteb_2 are not yet priced by VTU Africa
    unavailable: ['neco_2', 'nabteb_2'],
  },
  betting: {
    vtuFlatFee:     parseInt(process.env.PRICING_BETTING_VTU_FLAT_FEE)    || 20,
    ourMargin:      parseInt(process.env.PRICING_BETTING_OUR_MARGIN)       || 10,
    minAmount:      parseInt(process.env.PRICING_BETTING_MIN_AMOUNT)       || 100,
    microThreshold: parseInt(process.env.PRICING_BETTING_MICRO_THRESHOLD)  || 500,
    microMargin:    parseInt(process.env.PRICING_BETTING_MICRO_MARGIN)     || 30,
  },
  recipientFees: {
    airtimeData:      parseInt(process.env.PRICING_RECIPIENT_FEE_AIRTIME_DATA)      || 20,
    cableElectricity: parseInt(process.env.PRICING_RECIPIENT_FEE_CABLE_ELECTRICITY) || 30,
    examPin:          parseInt(process.env.PRICING_RECIPIENT_FEE_EXAM_PIN)          || 50,
    betting:          parseInt(process.env.PRICING_RECIPIENT_FEE_BETTING)           || 20,
  },

  // ─── CAC VAS (Business Registration & Validation) ─────────────────────────
  // User-facing prices (env-overridable). VAS costs are fixed by government schedule.
  cac: {
    // Business Name Registration
    bnStandard:        parseInt(process.env.PRICING_CAC_BN_STANDARD)          || 35000,
    bnPriority:        parseInt(process.env.PRICING_CAC_BN_PRIORITY)          || 38000,
    bnCertificate:     parseInt(process.env.PRICING_CAC_BN_CERTIFICATE)       || 500,
    bnStatusReport:    parseInt(process.env.PRICING_CAC_BN_STATUS_REPORT)     || 300,
    // LLC (future — prices held for when LLC docs are available)
    llcNameReservation: parseInt(process.env.PRICING_CAC_LLC_NAME_RESERVATION) || 5000,
    llcRegistration:   parseInt(process.env.PRICING_CAC_LLC_REGISTRATION)     || 80000,
    // Business Validation
    validateBasic:     parseInt(process.env.PRICING_CAC_VALIDATE_BASIC)       || 500,
    validateVRC:       parseInt(process.env.PRICING_CAC_VALIDATE_VRC)         || 15000,
    validatePremium:   parseInt(process.env.PRICING_CAC_VALIDATE_PREMIUM)     || 20000,
    // VAS costs (government-fixed, not env-overridable)
    costs: {
      bnStandard:    27000,
      bnPriority:    27500, // 27000 + 500 priority surcharge
      bnCertificate: 0,
      bnStatusReport:0,
      validateBasic: 100,
      validateVRC:   7500,
    },
  },
};

// ─── Config version ───────────────────────────────────────────────────────────
// Stored on every transaction so historical records are unambiguous when
// prices change. First 8 hex chars of SHA-256 of the config object.
const CONFIG_VERSION = crypto
  .createHash('sha256')
  .update(JSON.stringify(config))
  .digest('hex')
  .slice(0, 8);

// ─── Startup log ──────────────────────────────────────────────────────────────
function logStartup() {
  const b  = config.betting;
  const rf = config.recipientFees;
  console.log(
    `[PRICING] Loaded — ` +
    `Airtime MTN:${(config.airtime.mtn * 100).toFixed(1)}% ` +
    `Airtel:${(config.airtime.airtel * 100).toFixed(1)}% ` +
    `Glo:${(config.airtime.glo * 100).toFixed(1)}% ` +
    `9mobile:${(config.airtime['9mobile'] * 100).toFixed(1)}% | ` +
    `Data:${(config.data.markup * 100).toFixed(1)}%(min ₦${config.data.minMargin}) ` +
    `Cable:${(config.cable.markup * 100).toFixed(1)}%(min ₦${config.cable.minMargin}) ` +
    `Elec:${(config.electricity.markup * 100).toFixed(1)}%(min ₦${config.electricity.minMargin}) | ` +
    `Betting fee ₦${b.vtuFlatFee + b.ourMargin} (micro<₦${b.microThreshold}: ₦${b.vtuFlatFee + b.microMargin}) | ` +
    `Pay-for-others airtime/data:₦${rf.airtimeData} cable/elec:₦${rf.cableElectricity} ` +
    `exam:₦${rf.examPin} betting:₦${rf.betting} | ` +
    `config v${CONFIG_VERSION}`
  );
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function _round2(n) {
  return Math.round(n * 100) / 100;
}

function _normaliseNetwork(network) {
  const n = (network || '').toLowerCase();
  if (n.includes('mtn'))                            return 'mtn';
  if (n.includes('airtel'))                         return 'airtel';
  if (n.includes('glo'))                            return 'glo';
  if (n.includes('9mobile') || n.includes('etisalat')) return '9mobile';
  return 'mtn';
}

// ─── Airtime ──────────────────────────────────────────────────────────────────
/**
 * User tops up `amount` to a phone. We buy from VTpass at a discount.
 * Display: user sees the face value — no extra fee on own number.
 * forSomeoneElse adds ₦20 recipient fee.
 *
 * @returns {{ userPays, ourCost, ourMargin, recipientFee, marginType, provider }}
 */
function getAirtimePrice({ network, amount, forSomeoneElse = false }) {
  const key          = _normaliseNetwork(network);
  const markup       = config.airtime[key] ?? config.airtime.mtn;
  const recipientFee = forSomeoneElse ? config.recipientFees.airtimeData : 0;

  const ourCost   = _round2(amount * (1 - markup));
  const ourMargin = _round2(amount * markup + recipientFee);
  const userPays  = amount + recipientFee;

  return { userPays, ourCost, ourMargin, recipientFee, providerFee: 0, marginType: 'markup', provider: 'vtpass' };
}

// ─── Data ─────────────────────────────────────────────────────────────────────
/**
 * We know vtpassCost from the VTpass catalog / bundle list.
 * 2.5% markup with ₦20 floor.
 *
 * @returns {{ userPays, ourCost, ourMargin, recipientFee, providerFee, marginType, provider }}
 */
function getDataPrice({ vtpassCost, forSomeoneElse = false }) {
  const rawMargin    = _round2(vtpassCost * config.data.markup);
  const margin       = Math.max(rawMargin, config.data.minMargin);
  const recipientFee = forSomeoneElse ? config.recipientFees.airtimeData : 0;

  const userPays  = _round2(vtpassCost + margin + recipientFee);
  const ourMargin = _round2(margin + recipientFee);

  return { userPays, ourCost: vtpassCost, ourMargin, recipientFee, providerFee: 0, marginType: 'markup', provider: 'vtpass' };
}

// ─── Cable TV ─────────────────────────────────────────────────────────────────
/**
 * Cable is always treated as "pay for someone else" — user enters another
 * smartcard number. Recipient fee is always applied.
 * 2% markup with ₦50 floor.
 *
 * @returns {{ userPays, ourCost, ourMargin, recipientFee, providerFee, marginType, forSomeoneElse, provider }}
 */
function getCablePrice({ vtpassCost }) {
  const rawMargin    = _round2(vtpassCost * config.cable.markup);
  const margin       = Math.max(rawMargin, config.cable.minMargin);
  const recipientFee = config.recipientFees.cableElectricity;

  const userPays  = _round2(vtpassCost + margin + recipientFee);
  const ourMargin = _round2(margin + recipientFee);

  return { userPays, ourCost: vtpassCost, ourMargin, recipientFee, providerFee: 0, marginType: 'markup', forSomeoneElse: true, provider: 'vtpass' };
}

// ─── Electricity ──────────────────────────────────────────────────────────────
/**
 * Same treatment as cable — always for someone else.
 * 1.5% markup with ₦50 floor.
 *
 * @returns {{ userPays, ourCost, ourMargin, recipientFee, providerFee, marginType, forSomeoneElse, provider }}
 */
function getElectricityPrice({ vtpassCost }) {
  const rawMargin    = _round2(vtpassCost * config.electricity.markup);
  const margin       = Math.max(rawMargin, config.electricity.minMargin);
  const recipientFee = config.recipientFees.cableElectricity;

  const userPays  = _round2(vtpassCost + margin + recipientFee);
  const ourMargin = _round2(margin + recipientFee);

  return { userPays, ourCost: vtpassCost, ourMargin, recipientFee, providerFee: 0, marginType: 'markup', forSomeoneElse: true, provider: 'vtpass' };
}

// ─── Exam PINs ────────────────────────────────────────────────────────────────
/**
 * Fixed selling prices. VTU Africa costs are fixed provider rates.
 * Returns available:false for tier-unavailable products.
 *
 * @returns {{ available, userPays, ourCost, ourMargin, recipientFee, providerFee, sellingPrice, marginType, provider }}
 */
function getExamPinPrice({ examBody, productCode, forSomeoneElse = false }) {
  const key = `${(examBody || '').toLowerCase()}_${productCode}`;

  if (config.examPins.unavailable.includes(key)) {
    return { available: false, userPays: 0, ourCost: 0, ourMargin: 0, recipientFee: 0, providerFee: 0, provider: 'vtu-africa' };
  }

  const sellingPrice = config.examPins[key];
  const ourCost      = config.examPins.costs[key];

  if (!sellingPrice || !ourCost) {
    return { available: false, userPays: 0, ourCost: 0, ourMargin: 0, recipientFee: 0, providerFee: 0, provider: 'vtu-africa' };
  }

  const recipientFee = forSomeoneElse ? config.recipientFees.examPin : 0;
  const userPays     = sellingPrice + recipientFee;
  const ourMargin    = _round2(sellingPrice - ourCost + recipientFee);

  return {
    available: true,
    userPays,
    ourCost,
    ourMargin,
    recipientFee,
    providerFee: 0,
    sellingPrice,
    marginType: 'markup',
    provider: 'vtu-africa',
  };
}

// ─── Betting ──────────────────────────────────────────────────────────────────
/**
 * Fixed fee structure:
 *   Normal (≥₦500):  userPays = amount + ₦20 (VTU fee) + ₦10 (our margin) = amount + ₦30
 *   Micro  (<₦500):  userPays = amount + ₦20 (VTU fee) + ₦30 (our margin) = amount + ₦50
 *   forSomeoneElse adds ₦20 recipient fee on top.
 *
 * Throws with statusCode:400 if amount < minAmount.
 *
 * @returns {{ userPays, vtuAfricaCost, ourCost, providerFee, ourMargin, recipientFee, isMicro, marginType, provider, breakdown }}
 */
function getBettingPrice({ amount, forSomeoneElse = false }) {
  if (amount < config.betting.minAmount) {
    const err = new Error(`Minimum bet funding is ₦${config.betting.minAmount}.`);
    err.statusCode = 400;
    throw err;
  }

  const isMicro         = amount < config.betting.microThreshold;
  const ourMarginAmount = isMicro ? config.betting.microMargin : config.betting.ourMargin;
  const vtuFlatFee      = config.betting.vtuFlatFee;
  const serviceFee      = vtuFlatFee + ourMarginAmount;
  const recipientFee    = forSomeoneElse ? config.recipientFees.betting : 0;

  const userPays      = amount + serviceFee + recipientFee;
  const vtuAfricaCost = amount + vtuFlatFee;   // debited from our VTU Africa merchant wallet
  const ourMargin     = ourMarginAmount + recipientFee;

  return {
    userPays,
    vtuAfricaCost,
    ourCost:     vtuAfricaCost,
    providerFee: vtuFlatFee,
    ourMargin,
    recipientFee,
    isMicro,
    marginType: 'service_fee',
    provider: 'vtu-africa',
    breakdown: {
      amount,
      vtuFlatFee,
      ourMarginAmount,
      serviceFee,
      recipientFee,
      total: userPays,
    },
  };
}

// ─── Airtime2Cash ─────────────────────────────────────────────────────────────
/**
 * Returns payout details for an Airtime2Cash conversion.
 * deductionRate = what we show the user (Normal User tier).
 * ourCostRate   = what VTU Africa actually charges us (Portal Owner tier).
 * Spread is our margin.
 *
 * @returns {{ userReceives, ourCostAmount, ourMargin, deductionRate, provider }}
 */
function getAirtime2CashRate({ network, amount }) {
  const key           = _normaliseNetwork(network);
  const deductionRate = config.airtimeCash[key]        ?? config.airtimeCash.mtn;
  const costRate      = config.airtimeCash.costs[key]  ?? config.airtimeCash.costs.mtn;

  const userReceives   = _round2(amount * (1 - deductionRate));
  const ourCostAmount  = _round2(amount * (1 - costRate));   // what VTU Africa credits us
  const ourMargin      = _round2(ourCostAmount - userReceives);

  return {
    userReceives,
    ourCostAmount,
    ourMargin,
    deductionRate,
    costRate,
    provider: 'vtu-africa',
  };
}

// ─── Catalog ──────────────────────────────────────────────────────────────────
/**
 * Public catalog — final user-facing prices only.
 * Never include ourCost, costs, or margin detail.
 */
function getCatalog() {
  const b  = config.betting;
  const rf = config.recipientFees;
  return {
    airtime: {
      networks: ['mtn', 'airtel', 'glo', '9mobile'],
      note: 'Top up the face value — no extra fees on your own number.',
      recipientFee: rf.airtimeData,
    },
    data: {
      markup: `${(config.data.markup * 100).toFixed(1)}%`,
      minMargin: config.data.minMargin,
      recipientFee: rf.airtimeData,
    },
    cable: {
      recipientFee: rf.cableElectricity,
      note: 'Convenience fee always included.',
    },
    electricity: {
      recipientFee: rf.cableElectricity,
      note: 'Convenience fee always included.',
    },
    examPins: {
      waec: [
        { productCode: '1', name: 'Result Checking PIN',  userPays: config.examPins.waec_1,   available: !config.examPins.unavailable.includes('waec_1') },
        { productCode: '2', name: 'GCE Registration PIN', userPays: config.examPins.waec_2,   available: !config.examPins.unavailable.includes('waec_2') },
        { productCode: '3', name: 'Verification PIN',     userPays: config.examPins.waec_3,   available: !config.examPins.unavailable.includes('waec_3') },
      ],
      neco: [
        { productCode: '1', name: 'Result Checking Token', userPays: config.examPins.neco_1,   available: !config.examPins.unavailable.includes('neco_1') },
        { productCode: '2', name: 'GCE Registration PIN',  userPays: config.examPins.neco_2,   available: !config.examPins.unavailable.includes('neco_2') },
      ],
      nabteb: [
        { productCode: '1', name: 'Result Checking PIN',  userPays: config.examPins.nabteb_1, available: !config.examPins.unavailable.includes('nabteb_1') },
        { productCode: '2', name: 'GCE Registration PIN', userPays: config.examPins.nabteb_2, available: !config.examPins.unavailable.includes('nabteb_2') },
      ],
      jamb: [
        { productCode: '1', name: 'UTME Registration PIN',         userPays: config.examPins.jamb_1, available: !config.examPins.unavailable.includes('jamb_1') },
        { productCode: '2', name: 'Direct Entry Registration PIN', userPays: config.examPins.jamb_2, available: !config.examPins.unavailable.includes('jamb_2') },
      ],
      recipientFee: rf.examPin,
    },
    betting: {
      minAmount:      b.minAmount,
      maxAmount:      100000,
      normalFee:      b.vtuFlatFee + b.ourMargin,
      microFee:       b.vtuFlatFee + b.microMargin,
      microThreshold: b.microThreshold,
      recipientFee:   rf.betting,
      note: `Amounts below ₦${b.microThreshold} carry a ₦${b.vtuFlatFee + b.microMargin} service fee.`,
    },
  };
}

/**
 * CAC VAS pricing.
 *
 * @param {'bn_standard'|'bn_priority'|'bn_certificate'|'bn_status_report'|
 *         'validate_basic'|'validate_vrc'|'validate_premium'} serviceType
 * @returns {{ userPays, vasCost, ourMargin, provider }}
 */
function getCACPrice(serviceType) {
  const c = config.cac;
  const map = {
    bn_standard:     { userPays: c.bnStandard,        vasCost: c.costs.bnStandard },
    bn_priority:     { userPays: c.bnPriority,        vasCost: c.costs.bnPriority },
    bn_certificate:  { userPays: c.bnCertificate,     vasCost: c.costs.bnCertificate },
    bn_status_report:{ userPays: c.bnStatusReport,    vasCost: c.costs.bnStatusReport },
    validate_basic:  { userPays: c.validateBasic,     vasCost: c.costs.validateBasic },
    validate_vrc:    { userPays: c.validateVRC,        vasCost: c.costs.validateVRC },
    validate_premium:{ userPays: c.validatePremium,   vasCost: c.costs.validateVRC }, // same VAS cost
  };

  const entry = map[serviceType];
  if (!entry) {
    const err = new Error(`Unknown CAC service type: ${serviceType}`);
    err.statusCode = 400;
    throw err;
  }

  return {
    userPays:  entry.userPays,
    vasCost:   entry.vasCost,
    ourMargin: entry.userPays - entry.vasCost,
    provider:  'cac-vas',
  };
}

/**
 * Internal catalog — includes ourCost and margin detail.
 * Admin-only endpoint — never expose to users.
 */
function getInternalCatalog() {
  return {
    ...getCatalog(),
    _internal: {
      examPinCosts:       config.examPins.costs,
      airtimeMarkups:     config.airtime,
      dataConfig:         config.data,
      cableConfig:        config.cable,
      electricityConfig:  config.electricity,
      bettingConfig:      config.betting,
      recipientFees:      config.recipientFees,
      cacConfig:          config.cac,
      configVersion:      CONFIG_VERSION,
    },
  };
}

function getConfigVersion() {
  return CONFIG_VERSION;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  logStartup,
  getConfigVersion,

  getAirtimePrice,
  getDataPrice,
  getCablePrice,
  getElectricityPrice,
  getExamPinPrice,
  getBettingPrice,
  getAirtime2CashRate,

  getCACPrice,

  getCatalog,
  getInternalCatalog,
};
