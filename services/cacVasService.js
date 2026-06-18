'use strict';

/**
 * CAC VAS Service Layer
 *
 * Base URL is set via CAC_VAS_BASE_URL env var.
 *   Sandbox:    https://vasapp.oasisproducts.ng  (default)
 *   Production: https://vasapp.cac.gov.ng
 * Authentication: X_API_KEY header (never logged in plaintext).
 * Auto-retries on 5xx / network errors — 3 attempts, exponential backoff (1s, 2s).
 *
 * Security contract:
 *  - CAC_VAS_API_KEY is read from env at call time — never cached in module state.
 *  - _redactKey() replaces the key with [REDACTED] before any console call.
 *  - Never re-throw a raw axios error (it may contain the key in headers).
 */

const axios = require('axios');

const BASE_URL   = process.env.CAC_VAS_BASE_URL || 'https://vasapp.oasisproducts.ng';
const TIMEOUT_MS = 90_000;
const MAX_RETRIES = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  const key = process.env.CAC_VAS_API_KEY;
  if (!key) return str;
  return String(str).split(key).join('[REDACTED]');
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core POST helper with retry + key redaction.
 */
async function _post(path, body = {}) {
  const key = _getKey();
  const url = `${BASE_URL}${path}`;

  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[CAC VAS] → POST ${url} (attempt ${attempt}/${MAX_RETRIES})`);

      const { data } = await axios.post(url, body, {
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X_API_KEY': key,
        },
      });

      console.log(`[CAC VAS] ← status ${data?.statusCode} from ${path}`);
      return data;

    } catch (err) {
      const httpStatus = err.response?.status;
      const isRetryable = !httpStatus || httpStatus >= 500;

      console.warn(
        `[CAC VAS] Request failed (attempt ${attempt}/${MAX_RETRIES}):`,
        _redactKey(err.message),
        httpStatus ? `HTTP ${httpStatus}` : '(no response)'
      );

      lastErr = err;
      if (!isRetryable || attempt === MAX_RETRIES) break;
      await _sleep(attempt * 1_000);
    }
  }

  const message =
    lastErr?.response?.data?.message ||
    lastErr?.message ||
    'CAC VAS request failed';

  const error = new Error(_redactKey(message));
  error.statusCode = lastErr?.response?.status || 503;
  error.vasRaw     = lastErr?.response?.data ?? null;
  throw error;
}

/**
 * Core GET helper with retry + key redaction.
 */
async function _get(path) {
  const key = _getKey();
  const url = `${BASE_URL}${path}`;

  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[CAC VAS] → GET ${url} (attempt ${attempt}/${MAX_RETRIES})`);

      const { data } = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: { 'X_API_KEY': key },
      });

      console.log(`[CAC VAS] ← status ${data?.statusCode} from ${path}`);
      return data;

    } catch (err) {
      const httpStatus = err.response?.status;
      const isRetryable = !httpStatus || httpStatus >= 500;

      console.warn(
        `[CAC VAS] GET failed (attempt ${attempt}/${MAX_RETRIES}):`,
        _redactKey(err.message),
        httpStatus ? `HTTP ${httpStatus}` : '(no response)'
      );

      lastErr = err;
      if (!isRetryable || attempt === MAX_RETRIES) break;
      await _sleep(attempt * 1_000);
    }
  }

  const message = lastErr?.response?.data?.message || lastErr?.message || 'CAC VAS request failed';
  const error   = new Error(_redactKey(message));
  error.statusCode = lastErr?.response?.status || 503;
  throw error;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Quick name availability / compliance check (no full payload needed).
 * Uses the BN compliance endpoint, same as bnCompliance().
 * advanceCheck is a query parameter per VAS docs.
 */
async function validateBusinessName({ proposedName, lineOfBusiness }) {
  return _post('/api/vas/engine/pre/bn-compliance?advanceCheck=true', {
    proposedName,
    lineOfBusiness: lineOfBusiness || '',
  });
}

/**
 * Business Name Registration (main paid endpoint).
 * @param {object} registrationData  - all required CAC fields
 * @param {boolean} priorityService  - true adds ₦500 cost and faster approval
 * @param {string}  transactionRef   - unique ref, format VAS + timestamp
 */
async function registerBusinessName({ registrationData, priorityService, transactionRef }) {
  const params = new URLSearchParams();
  if (priorityService) params.set('priorityService', 'true');

  const path = `/api/vas/engine/pre/business-name${params.toString() ? `?${params}` : ''}`;
  return _post(path, { ...registrationData, transactionRef });
}

/**
 * Poll registration status by transactionRef.
 * Use for reconciliation when webhook has not fired.
 */
async function checkRegistrationStatus({ transactionRef }) {
  return _get(`/api/vas/portal/user/status/${transactionRef}`);
}

/**
 * Download CAC certificate after approval.
 */
async function downloadCertificate({ transactionRef }) {
  return _post('/api/vas/engine/pre/certificate', { transactionRef });
}

/**
 * Validation: look up company by RC Number.
 */
async function getCompanyByRC({ rcNumber }) {
  return _post('/api/vas/validation/secure/company-rc', { rcNumber });
}

/**
 * Validation: look up company by name.
 */
async function getCompanyByName({ name, rcNumber }) {
  return _post('/api/vas/validation/company/name', {
    entity_name: name,
    ...(rcNumber && { rc_number: rcNumber }),
  });
}

/**
 * Validation: look up company by TIN.
 */
async function getCompanyByTIN({ tin }) {
  return _post('/api/vas/validation/secure/company-tin', { tin });
}

/**
 * VRC full report — type determines which sub-endpoint is called.
 * @param {string} vrc        - VRC code from VAS dashboard
 * @param {string} reportType - one of: share_distribution | share_capital | assets |
 *                              status_report | certificate | wind_up | affiliates | company
 */
async function getVRCReport({ vrc, reportType }) {
  const pathMap = {
    share_distribution: '/api/vas/validation/secure/share-distribution',
    share_capital:      '/api/vas/validation/secure/share-capital',
    assets:             '/api/vas/validation/secure/assets',
    status_report:      '/api/vas/validation/secure/status-report',
    certificate:        '/api/vas/validation/secure/certificate',
    wind_up:            '/api/vas/validation/secure/wind-up',
    affiliates:         '/api/vas/validation/secure/affiliates',
    company:            '/api/vas/validation/secure/company',
  };

  const path = pathMap[reportType];
  if (!path) {
    const err = new Error(`Unknown VRC report type: ${reportType}`);
    err.statusCode = 400;
    throw err;
  }

  return _post(path, { vrc });
}

/**
 * Generate TIN for a company.
 */
async function generateTIN({ rcNumber }) {
  return _post('/api/vas/validation/secure/generate-tin', { rcNumber });
}

/**
 * BN Compliance pre-check.
 * advanceCheck is a query parameter per VAS docs.
 * Free — no wallet deduction.
 * Returns statusCode, message, recommendedActions, suggestedNames, similarNames.
 */
async function bnCompliance({ proposedName, lineOfBusiness }) {
  return _post('/api/vas/engine/pre/bn-compliance?advanceCheck=true', {
    proposedName,
    lineOfBusiness: lineOfBusiness || '',
  });
}

/**
 * Validate full BN registration payload before wallet deduction.
 * Caller must strip base64 image fields before passing payload here.
 */
async function validateBnPayload(payload) {
  return _post('/api/vas/engine/pre/bn/validation', payload);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  validateBusinessName,
  registerBusinessName,
  checkRegistrationStatus,
  downloadCertificate,
  getCompanyByRC,
  getCompanyByName,
  getCompanyByTIN,
  getVRCReport,
  generateTIN,
  bnCompliance,
  validateBnPayload,
};
