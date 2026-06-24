'use strict';

/**
 * CAC LLC VAS Service Layer
 *
 * Handles all calls to the VAS LLC and AI memorandum endpoints.
 *   Base URL (env var):
 *     Sandbox:    https://vasapp.oasisproducts.ng  (default)
 *     Production: https://vasapp.cac.gov.ng
 *
 * Security: X_API_KEY is read from env at call-time, never logged.
 * Pattern mirrors cacVasService.js: 3-attempt exponential-backoff retry,
 * key redaction on all console output.
 */

const axios = require('axios');

const BASE_URL   = () => process.env.CAC_VAS_BASE_URL || 'https://vasapp.oasisproducts.ng';
const TIMEOUT_MS  = 90_000;
const MAX_RETRIES = 3;

function _getKey() {
  const key = process.env.CAC_VAS_API_KEY;
  if (!key || !key.trim()) {
    const err = new Error('CAC_VAS_API_KEY is not configured.');
    err.statusCode = 503;
    throw err;
  }
  return key.trim();
}

function _redactKey(str) {
  const key = process.env.CAC_VAS_API_KEY || '';
  if (!key || !str) return String(str || '');
  return String(str).split(key).join('[REDACTED]');
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _post(path, body = {}) {
  const key = _getKey();
  const url = `${BASE_URL()}${path}`;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[CAC LLC VAS] → POST ${url} (attempt ${attempt}/${MAX_RETRIES})`);
      const { data } = await axios.post(url, body, {
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'X_API_KEY': key },
      });
      console.log(`[CAC LLC VAS] ← OK from ${path}`);
      return data;
    } catch (err) {
      const httpStatus  = err.response?.status;
      // Only retry on network-level failures (no response) or 502/503/504 gateway errors.
      // VAS returns 500 for application-level rejections (e.g. account not yet activated) —
      // retrying those wastes time without any chance of success.
      const isRetryable = !httpStatus || httpStatus === 502 || httpStatus === 503 || httpStatus === 504;
      const rawBody     = err.response?.data;
      console.warn(
        `[CAC LLC VAS] POST failed (attempt ${attempt}/${MAX_RETRIES}): HTTP ${httpStatus ?? '(no response)'}`,
        _redactKey(err.message)
      );
      console.warn('[CAC LLC VAS] Response body:', rawBody != null ? JSON.stringify(rawBody).substring(0, 500) : '(empty)');
      lastErr = err;
      if (!isRetryable || attempt === MAX_RETRIES) break;
      await _sleep(attempt * 1_000);
    }
  }

  const raw     = lastErr?.response?.data;
  const message = raw?.message || raw?.error || raw?.description
    || (typeof raw === 'string' && raw.length < 200 ? raw : null)
    || lastErr?.message
    || 'CAC LLC VAS request failed';
  const error   = new Error(_redactKey(message));
  error.statusCode = lastErr?.response?.status || 503;
  error.vasRaw     = raw ?? null;
  throw error;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Step 1 — Reserve a company name.
 * Returns: { reservationCode, expiryDate }
 */
async function reserveName({ proposedName, companyTypes }) {
  const payload = { proposedName, companyTypes };
  console.log('[cac-llc] reserveName payload:', JSON.stringify(payload));
  return _post('/api/vas/llc/name-reservation', payload);
}

/**
 * Step 2 — Generate memorandum objects via AI.
 * natureOfBusiness is sent as an array per API spec.
 * Returns: { objectsOfMem: [...] }
 */
async function generateMemoObjects({ countOfObjects, natureOfBusiness }) {
  return _post('/api/vas/ai/memorandum-object/generate-objects', {
    countOfObjects,
    natureOfBusiness: Array.isArray(natureOfBusiness) ? natureOfBusiness : [natureOfBusiness],
  });
}

/**
 * Step 3 — Analyse memorandum objects.
 * Returns shareInfo.minimumShareCapital, regulatory requirements, etc.
 */
async function analyseMemoObjects({ objects }) {
  return _post('/api/vas/ai/memorandum-object/analyse-objects', { objects });
}

/**
 * Step 4 — Create the company.
 * Returns: { data: { transactionRef } }
 */
async function createCompany(payload) {
  // Pass the payload through exactly as constructed by the controller.
  // companyAddress already has the correct { registeredAddress, headOffice } shape.
  return _post('/api/vas/llc/company', payload);
}

/**
 * Step 5 — Register shares.
 * shareCapital = (ordinaryIssuedShare * pricePerShare) + (preferenceIssuedShare * pricePerShare)
 */
async function registerShares({ transactionRef, ordinaryIssuedShare, pricePerShare, preferenceIssuedShare }) {
  return _post('/api/vas/llc/shares', {
    transactionRef,
    ordinaryIssuedShare,
    pricePerShare,
    preferenceIssuedShare: preferenceIssuedShare || 0,
  });
}

/**
 * Step 6 — Register an affiliate (individual or corporate).
 * VAS requires the affiliate object nested under "individual" or "corporate" key.
 */
async function registerAffiliate({ transactionRef, affiliateMode, affiliate }) {
  const key = affiliateMode === 'corporate' ? 'corporate' : 'individual';
  return _post('/api/vas/llc/affiliates', { transactionRef, [key]: affiliate });
}

/**
 * Step 7 — Register a Person with Significant Control (PSC).
 * affiliateKey comes from the registerAffiliate response (data.affiliateKey).
 */
async function registerPsc({
  transactionRef, affiliateKey,
  ownsDirectShares, directShareDetails,
  ownsIndirectShares, indirectShareDetails,
  isPep, isPscAffiliated, canChangeDirectors, hasSignificantControlOfCompany,
}) {
  const body = {
    transactionRef,
    affiliateKey,
    ownsDirectShares:              !!ownsDirectShares,
    ownsIndirectShares:            !!ownsIndirectShares,
    isPep:                         !!isPep,
    isPscAffiliated:               !!isPscAffiliated,
    canChangeDirectors:            !!canChangeDirectors,
    hasSignificantControlOfCompany: !!hasSignificantControlOfCompany,
    ...(ownsDirectShares   && directShareDetails   && { directShareDetails }),
    ...(ownsIndirectShares && indirectShareDetails && { indirectShareDetails }),
  };
  return _post('/api/vas/llc/psc', body);
}

/**
 * Step 8 — Submit the full registration to CAC.
 * Body is just { transactionRef }. VAS handles payment from our credits.
 */
async function submitRegistration({ transactionRef }) {
  return _post('/api/vas/llc/register', { transactionRef });
}

module.exports = {
  reserveName,
  generateMemoObjects,
  analyseMemoObjects,
  createCompany,
  registerShares,
  registerAffiliate,
  registerPsc,
  submitRegistration,
};
