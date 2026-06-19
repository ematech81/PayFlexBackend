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
      const isRetryable = !httpStatus || httpStatus >= 500;
      console.warn(
        `[CAC LLC VAS] POST failed (attempt ${attempt}/${MAX_RETRIES}):`,
        _redactKey(err.message),
        httpStatus ? `HTTP ${httpStatus}` : '(no response)'
      );
      lastErr = err;
      if (!isRetryable || attempt === MAX_RETRIES) break;
      await _sleep(attempt * 1_000);
    }
  }

  const message = lastErr?.response?.data?.message || lastErr?.message || 'CAC LLC VAS request failed';
  const error   = new Error(_redactKey(message));
  error.statusCode = lastErr?.response?.status || 503;
  error.vasRaw     = lastErr?.response?.data ?? null;
  throw error;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Step 1 — Reserve a company name.
 * Returns: { reservationCode, expiryDate }
 */
async function reserveName({ proposedName, companyTypes }) {
  return _post('/api/vas/llc/name-reservation', { proposedName, companyTypes });
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
async function createCompany({
  reservationCode, companyType, natureOfBusinessCategory, natureOfBusiness,
  principalActivityDescription, companyEmail, phoneNumber, companyAddress, objectsOfMem,
}) {
  return _post('/api/vas/llc/company', {
    reservationCode,
    companyType,
    natureOfBusinessCategory,
    natureOfBusiness,
    principalActivityDescription,
    companyEmail,
    phoneNumber,
    companyAddress: {
      registeredAddress: companyAddress.registeredAddress,
      headOffice:        companyAddress.headOffice,
    },
    objectsOfMem,
  });
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
 * affiliate object is spread directly into the request body alongside transactionRef.
 */
async function registerAffiliate({ transactionRef, affiliate }) {
  return _post('/api/vas/llc/affiliates', { transactionRef, ...affiliate });
}

module.exports = {
  reserveName,
  generateMemoObjects,
  analyseMemoObjects,
  createCompany,
  registerShares,
  registerAffiliate,
};
