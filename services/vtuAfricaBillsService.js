'use strict';

/**
 * VTU Africa Bills Service
 *
 * Handles Airtime, Data, Cable TV, and Electricity via VTU Africa.
 *
 * Reuses the low-level HTTP client (vtuGet) and security helpers
 * (redactKey) from the existing vtuAfricaService — single source of
 * truth for key management, base URL selection, and retry logic.
 *
 * Security contract (inherited from vtuAfricaService):
 *  - API key injected by vtuGet — never passed by callers.
 *  - All logs use redactKey() — key never appears in plaintext.
 *  - validateStartup() in vtuAfricaService must run at boot before
 *    any call here will succeed.
 */

const { vtuGet, redactKey } = require('./vtuAfricaService');

// ─── Error code → user-friendly message ──────────────────────────────────────

const ERROR_MESSAGES = {
  102: 'Insufficient balance. Please fund your VTU wallet.',          // ops alert
  103: null,                                                            // NEVER shown to user — ops alert only
  104: 'This transaction was already processed. Check your history.',
  105: 'Invalid amount. Please check the amount and try again.',
  204: 'This service is temporarily unavailable. Please try again shortly.',
  400: 'Please check all details and try again.',
  403: 'Invalid transaction amount. Please try a different amount.',
  404: 'Invalid service code. Please contact support.',
  405: 'Amount is below our minimum for this service. Please increase the amount.',
};

/**
 * Map a VTU Africa response code to a user-facing message.
 * Code 101 = success.
 * Code 102/103 = ops alerts (logged internally, not surfaced to user).
 * Returns null for success, throws for errors.
 */
function _handleCode(code, rawDescription) {
  const c = Number(code);
  if (c === 101) return; // success — caller continues

  if (c === 102) {
    console.error('[vtuAfricaBills] ⚠️  LOW WALLET BALANCE — ops alert required. VTU Africa wallet critically low.');
    const err = new Error(ERROR_MESSAGES[102]);
    err.code = 102; err.opsAlert = true;
    throw err;
  }

  if (c === 103) {
    console.error('[vtuAfricaBills] 🚨 INVALID API KEY / ACCOUNT — ops alert required. Never show to user.');
    const err = new Error('Service temporarily unavailable.');
    err.code = 103; err.opsAlert = true;
    throw err;
  }

  const userMsg = ERROR_MESSAGES[c] || `Transaction failed (code ${c}). Please try again.`;
  const rawMsg  = rawDescription?.message || rawDescription?.Message || '';
  console.warn(`[vtuAfricaBills] Code ${c}: ${redactKey(rawMsg)}`);
  const err = new Error(userMsg);
  err.code = c;
  throw err;
}

// ─── Webhook URL helper ───────────────────────────────────────────────────────

function _webhookUrl() {
  return process.env.VTUAFRICA_WEBHOOK_URL || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 1: AIRTIME
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Purchase airtime for any network.
 *
 * @param {object} opts
 * @param {string} opts.network     - 'mtn' | 'airtel' | 'glo' | '9mobile'
 * @param {string} opts.phone       - recipient phone
 * @param {number} opts.amount      - recharge amount (NGN)
 * @param {string} opts.ref         - unique ref, format: payflex-air-{uuid}
 * @returns {object} normalised result
 */
async function purchaseAirtime({ network, phone, amount, ref }) {
  const raw = await vtuGet('/airtime/', {
    network:    network.toLowerCase(),
    phone,
    amount,
    ref,
    webhookURL: _webhookUrl(),
  });

  _handleCode(raw.code, raw.description);

  const d = raw.description || {};
  return {
    success:           true,
    status:            d.Status || 'Completed',
    productName:       d.ProductName || `${network.toUpperCase()} Airtime`,
    amount:            Number(d.amount          || amount),
    amountCharged:     Number(d.Amount_Charged  || amount),
    vtuAfricaCommission: Number(d.amount || amount) - Number(d.Amount_Charged || amount),
    previousBalance:   Number(d.Previous_Balance || 0),
    currentBalance:    Number(d.Current_Balance  || 0),
    phone:             d.MobileNumber || phone,
    referenceId:       d.ReferenceID  || ref,
    message:           d.message      || 'Recharge Successful',
    transactionDate:   d.transaction_date || new Date().toISOString(),
    raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 2: DATA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Purchase a data bundle.
 *
 * @param {object} opts
 * @param {string} opts.service        - VTU Africa service code (e.g. 'MTNSME')
 * @param {string} opts.MobileNumber   - recipient phone (capital M+N required by API)
 * @param {string} opts.DataPlan       - plan code (e.g. '1000')
 * @param {number} opts.costPrice      - plan cost price (used for maxamount buffer)
 * @param {string} opts.ref            - unique ref, format: payflex-data-{uuid}
 * @returns {object} normalised result
 */
async function purchaseData({ service, MobileNumber, DataPlan, costPrice, ref }) {
  const maxamount = Math.ceil(Number(costPrice) * 1.1); // 10% buffer per spec

  const raw = await vtuGet('/data/', {
    service,
    MobileNumber,   // exact casing required by API
    DataPlan,
    ref,
    maxamount,
    webhookURL: _webhookUrl(),
  });

  _handleCode(raw.code, raw.description);

  const d = raw.description || {};
  return {
    success:         true,
    status:          d.Status       || 'Completed',
    productName:     d.ProductName  || `${service} Data`,
    dataPlanId:      d.DataPlanID   || DataPlan,
    dataSize:        d.DataSize     || '',
    validity:        d.Validity     || '',
    amountCharged:   Number(d.Amount_Charged  || costPrice),
    previousBalance: Number(d.Previous_Balance || 0),
    currentBalance:  Number(d.Current_Balance  || 0),
    phone:           d.MobileNumber || MobileNumber,
    referenceId:     d.ReferenceID  || ref,
    message:         d.message      || 'TRANSACTION SUCCESSFUL',
    transactionDate: d.transaction_date || new Date().toISOString(),
    raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 3: CABLE TV — two-step: verify → purchase
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: Verify a smartcard number before charging.
 * Always call this and show the customer name to the user before proceeding.
 *
 * @param {object} opts
 * @param {string} opts.service    - 'dstv' | 'gotv' | 'startimes' | 'showmax'
 * @param {string} opts.smartNo   - smartcard / IUC number
 * @param {string} opts.variation - subscription plan code (e.g. 'gotv_jinja')
 * @returns {object} customer details
 */
async function verifySmartcard({ service, smartNo, variation }) {
  const raw = await vtuGet('/merchant-verify/', {
    serviceName: 'CableTV',   // exact casing required
    service:     service.toLowerCase(),
    smartNo,
    variation,
  });

  _handleCode(raw.code, raw.description);

  const d = raw.description || {};
  return {
    success:        true,
    customerName:   d.Customer       || '',
    service:        d.Service        || service,
    smartNo:        d.SmartNo        || smartNo,
    currentBouquet: d.Current_Bouquet || '',
    currentStatus:  d.Current_Status  || '',
    dueDate:        d.Due_Date        || '',
    customerNumber: d.CustomerNumber  || '',
    address:        d.Address         || '',
    message:        d.message         || 'Verification Successful',
    raw,
  };
}

/**
 * Step 2: Purchase a Cable TV subscription.
 * Only call after verifySmartcard and user confirmation.
 *
 * @param {object} opts
 * @param {string} opts.service    - 'dstv' | 'gotv' | 'startimes' | 'showmax'
 * @param {string} opts.smartNo   - smartcard / IUC number
 * @param {string} opts.variation - plan variation code
 * @param {number} opts.costPrice - plan cost price (used for maxamount buffer)
 * @param {string} opts.ref       - unique ref, format: payflex-tv-{uuid}
 * @returns {object} normalised result
 */
async function purchaseTVSubscription({ service, smartNo, variation, costPrice, ref }) {
  const maxamount = Math.ceil(Number(costPrice) * 1.1);

  const raw = await vtuGet('/paytv/', {
    service:    service.toLowerCase(),
    smartNo,
    variation,
    ref,
    maxamount,
    webhookURL: _webhookUrl(),
  });

  _handleCode(raw.code, raw.description);

  const d = raw.description || {};
  return {
    success:         true,
    status:          d.Status        || 'Completed',
    productName:     d.ProductName   || `${service.toUpperCase()} Subscription`,
    smartNo:         d.SmartNo       || smartNo,
    amountCharged:   Number(d.Amount_Charged  || costPrice),
    previousBalance: Number(d.Previous_Balance || 0),
    currentBalance:  Number(d.Current_Balance  || 0),
    referenceId:     d.ReferenceID   || ref,
    message:         d.message       || 'Subscription Successful',
    transactionDate: d.transaction_date || new Date().toISOString(),
    raw,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE 4: ELECTRICITY — two-step: verify → purchase (token delivery)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: Verify a meter number before charging.
 * Always call this and show customer name + meter type before proceeding.
 *
 * @param {object} opts
 * @param {string} opts.service    - disco code e.g. 'ikeja-electric'
 * @param {string} opts.meterNo   - meter number
 * @param {string} opts.metertype - 'prepaid' | 'postpaid'
 * @returns {object} customer details
 */
async function verifyMeter({ service, meterNo, metertype }) {
  const raw = await vtuGet('/merchant-verify/', {
    serviceName: 'Electricity',   // exact casing required
    service,
    meterNo,
    metertype,
  });

  _handleCode(raw.code, raw.description);

  const d = raw.description || {};
  return {
    success:       true,
    customerName:  d.Customer      || '',
    customerNo:    d.customerNo    || '',
    service:       d.Service       || service,
    meterNumber:   d.MeterNumber   || meterNo,
    meterType:     d.MeterType     || metertype,
    address:       d.Address       || '',
    variationCode: d.Variation_Code || service,
    message:       d.message       || 'Verification Successful',
    raw,
  };
}

/**
 * Step 2: Purchase an electricity token.
 * webhookURL is REQUIRED — token may arrive via webhook.
 * Token is also returned in the response when available.
 *
 * @param {object} opts
 * @param {string} opts.service    - disco code e.g. 'ikeja-electric'
 * @param {string} opts.meterNo   - meter number
 * @param {string} opts.metertype - 'prepaid' | 'postpaid'
 * @param {number} opts.amount    - payment amount (NGN)
 * @param {string} opts.ref       - unique ref, format: payflex-elec-{uuid}
 * @returns {object} normalised result with token if available
 */
async function purchaseElectricity({ service, meterNo, metertype, amount, ref }) {
  const webhookURL = _webhookUrl();
  if (!webhookURL) {
    console.warn('[vtuAfricaBills] ⚠️  VTUAFRICA_WEBHOOK_URL not set — electricity token may not be delivered.');
  }

  const raw = await vtuGet('/electric/', {
    service,
    meterNo,
    metertype,
    amount,
    ref,
    webhookURL,
  });

  _handleCode(raw.code, raw.description);

  const d = raw.description || {};
  const token = d.Token || d.token || null;
  const unit  = d.Unit  || d.unit  || null;

  if (token) {
    console.log(`[vtuAfricaBills] Electricity token received in response for ref ${ref}`);
  } else {
    console.log(`[vtuAfricaBills] No token in response for ref ${ref} — expecting webhook delivery`);
  }

  return {
    success:         true,
    status:          d.Status       || 'Completed',
    productName:     d.ProductName  || 'Electricity Payment',
    meterNumber:     d.MeterNumber  || meterNo,
    meterType:       d.MeterType    || metertype,
    token,                              // null if not yet delivered — arrives via webhook
    unit,
    requestAmount:   Number(d.Request_Amount  || amount),
    amountCharged:   Number(d.Amount_Charged  || amount),
    previousBalance: Number(d.Previous_Balance || 0),
    currentBalance:  Number(d.Current_Balance  || 0),
    referenceId:     d.ReferenceID  || ref,
    message:         d.message      || 'Recharge Successful',
    transactionDate: d.transaction_date || new Date().toISOString(),
    tokenDeliveredInResponse: !!token,
    raw,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Airtime
  purchaseAirtime,

  // Data
  purchaseData,

  // Cable TV (two-step)
  verifySmartcard,
  purchaseTVSubscription,

  // Electricity (two-step + token)
  verifyMeter,
  purchaseElectricity,
};
