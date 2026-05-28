'use strict';

/**
 * CAC VAS Service Layer
 *
 * All calls go to https://vasapp.cac.gov.ng via Axios.
 * Authentication: X_API_KEY header (never logged in plaintext).
 * Auto-retries on 5xx / network errors — 3 attempts, exponential backoff (1s, 2s).
 *
 * Security contract:
 *  - CAC_VAS_API_KEY is read from env at call time — never cached in module state.
 *  - _redactKey() replaces the key with [REDACTED] before any console call.
 *  - Never re-throw a raw axios error (it may contain the key in headers).
 */

const axios = require('axios');

const BASE_URL   = process.env.CAC_VAS_BASE_URL || 'https://vasapp.cac.gov.ng';
const TIMEOUT_MS = 30_000;
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
 * BN Pre-Registration Validation — free name availability check.
 * Always call before charging the user.
 */
async function validateBusinessName({ proposedName, transactionRef }) {
  return _post('/api/vas/engine/pre/bn/validation', {
    rcNumber:       proposedName,  // VAS uses rcNumber field for the name check
    transactionRef: transactionRef || `VAS${Date.now()}`,
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
async function getCompanyByName({ name }) {
  return _post('/api/vas/validation/secure/company-name', { name });
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
};
