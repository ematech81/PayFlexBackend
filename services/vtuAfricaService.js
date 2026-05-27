'use strict';

/**
 * VTU Africa Service Layer
 *
 * Security contract:
 *  - The active API key is resolved once at startup and cached in _cachedKey.
 *  - _cachedKey is NEVER written to any log. Use redactKey() before every
 *    console call. The vtuGet() helper enforces this automatically.
 *  - In sandbox mode the key is a phone number — treat it with the same
 *    sensitivity as a password.
 *  - In live mode, if the key looks like a phone number the process exits
 *    immediately at validateStartup().
 */

const axios  = require('axios');
const crypto = require('crypto');

// ─── Module-level state ───────────────────────────────────────────────────────
let _cachedKey  = null;
let _cachedMode = null;

// ─── Constants ────────────────────────────────────────────────────────────────
const SANDBOX_BASE  = 'https://vtuafrica.com.ng/portal/api-test';
const LIVE_BASE     = 'https://vtuafrica.com.ng/portal/api';
const TIMEOUT_MS    = 30_000;
const MAX_RETRIES   = 3;

// Nigerian phone number pattern: 10–13 digits starting with 0 or 234
const PHONE_PATTERN = /^(0\d{9,12}|234\d{9,10})$/;

// ─── Startup Validation ───────────────────────────────────────────────────────
/**
 * Must be called once at server boot before accepting any traffic.
 * Reads VTUAFRICA_MODE, resolves the correct key, and enforces safety rules.
 * Calls process.exit(1) — not throw — on any critical misconfiguration so the
 * server never starts in an unsafe state.
 */
function validateStartup() {
  const mode = (process.env.VTUAFRICA_MODE || 'sandbox').toLowerCase().trim();

  if (mode !== 'sandbox' && mode !== 'live') {
    console.error(
      `[VTU Africa] VTUAFRICA_MODE must be "sandbox" or "live", got: "${mode}". Refusing to start.`
    );
    process.exit(1);
  }

  const key =
    mode === 'live'
      ? process.env.VTUAFRICA_LIVE_KEY
      : process.env.VTUAFRICA_SANDBOX_KEY;

  if (!key || !key.trim()) {
    console.error(
      `[VTU Africa] VTUAFRICA_${mode.toUpperCase()}_KEY is not set. Refusing to start.\n` +
      (mode === 'sandbox'
        ? '  Set it to your registered VTU Africa phone number for sandbox testing.'
        : '  Set it to your live API key from the VTU Africa dashboard.')
    );
    process.exit(1);
  }

  const trimmedKey = key.trim();

  // ── CRITICAL safety gate ──────────────────────────────────────────────────
  // The sandbox credential IS a phone number. If someone accidentally sets
  // VTUAFRICA_MODE=live but forgets to swap the key, we catch it here.
  if (mode === 'live' && PHONE_PATTERN.test(trimmedKey.replace(/\s/g, ''))) {
    console.error(
      '[VTU Africa] CRITICAL: VTUAFRICA_LIVE_KEY matches a phone number pattern.\n' +
      '  This is almost certainly the SANDBOX key (your registered phone number).\n' +
      '  Switch VTUAFRICA_MODE to "sandbox", or supply the real live API key.\n' +
      '  Refusing to start.'
    );
    process.exit(1);
  }

  _cachedKey  = trimmedKey;
  _cachedMode = mode;

  // Log mode but NEVER the key value
  console.log(`[VTU Africa] Initialised in ${mode.toUpperCase()} mode.`);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function _getKey() {
  if (!_cachedKey) {
    throw new Error(
      'vtuAfricaService: validateStartup() was not called. Cannot make API calls.'
    );
  }
  return _cachedKey;
}

function _getBaseUrl() {
  return _cachedMode === 'live' ? LIVE_BASE : SANDBOX_BASE;
}

/**
 * Replace every occurrence of the live API key in a string with [REDACTED].
 * Safe to call with null/undefined — returns the input unchanged.
 */
function redactKey(str) {
  if (!_cachedKey || str == null) return str;
  // Replace the raw key value wherever it might appear (URL, message, etc.)
  return String(str).split(_cachedKey).join('[REDACTED]');
}

/** Promise-based sleep. */
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse a VTU Africa response body.
 *
 * The live API sometimes returns two JSON objects concatenated in a single
 * response body, e.g.:
 *   {"customer_name":"...","status":"100"}{"code":101,"description":{...}}
 *
 * JSON.parse() rejects that, so axios hands back a string.  We extract all
 * top-level JSON objects from the string and prefer the one that contains
 * "code" — that is VTU Africa's authoritative result envelope.
 */
function _parseBody(data) {
  if (data !== null && typeof data === 'object') return data;

  const str = String(data).trim();

  try { return JSON.parse(str); } catch (_) { /* fall through */ }

  const objects = [];
  let depth = 0, start = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (str[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try { objects.push(JSON.parse(str.slice(start, i + 1))); } catch (_) { /* skip unparseable segment */ }
        start = -1;
      }
    }
  }

  const authoritative = objects.find(o => 'code' in o);
  if (authoritative) return authoritative;
  if (objects.length) return objects[objects.length - 1];

  throw new Error('VTU Africa returned an unparseable response');
}

// ─── Core HTTP client ─────────────────────────────────────────────────────────
/**
 * Make an authenticated GET request to VTU Africa.
 * - Injects apikey automatically so callers never touch it.
 * - Logs the outgoing URL with apikey replaced by [REDACTED].
 * - Auto-retries on 5xx / network errors with exponential backoff (1 s, 2 s).
 * - Throws a clean Error on final failure — raw axios error (which contains
 *   params / URL fragments) is never re-thrown directly.
 *
 * @param {string} path   - e.g. '/exam-pin/'
 * @param {object} params - query params WITHOUT apikey
 * @returns {object}      - parsed VTU Africa response body
 */
async function vtuGet(path, params = {}) {
  const key       = _getKey();
  const baseUrl   = _getBaseUrl();
  const url       = `${baseUrl}${path}`;
  const fullParams = { apikey: key, ...params };

  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Build a loggable version of the URL — key replaced with [REDACTED]
      const safeUrl = redactKey(
        `${url}?${new URLSearchParams(fullParams).toString()}`
      );
      console.log(`[VTU Africa] → GET ${safeUrl} (attempt ${attempt}/${MAX_RETRIES})`);

      const { data } = await axios.get(url, {
        params:       fullParams,
        timeout:      TIMEOUT_MS,
        responseType: 'text',   // always get raw string; we parse manually
      });

      const parsed = _parseBody(data);
      console.log(`[VTU Africa] ← parsed:`, JSON.stringify(parsed));
      return parsed;

    } catch (err) {
      const httpStatus = err.response?.status;
      // Retry on network errors (no status) or 5xx from VTU Africa
      const isRetryable = !httpStatus || httpStatus >= 500;

      console.warn(
        `[VTU Africa] Request failed (attempt ${attempt}/${MAX_RETRIES}):`,
        redactKey(err.message),
        httpStatus ? `HTTP ${httpStatus}` : '(no response)'
      );

      lastErr = err;

      if (!isRetryable || attempt === MAX_RETRIES) break;

      // Exponential backoff: 1 s then 2 s
      await _sleep(attempt * 1_000);
    }
  }

  // Surface a clean error — never expose raw axios error or URL with key
  const vtuMessage =
    lastErr?.response?.data?.description?.message ||
    (typeof lastErr?.response?.data?.description === 'string'
      ? lastErr.response.data.description
      : null) ||
    lastErr?.message ||
    'VTU Africa request failed';

  const error     = new Error(redactKey(vtuMessage));
  error.statusCode = lastErr?.response?.status || 503;
  error.vtuRaw    = lastErr?.response?.data ?? null;
  throw error;
}

// ─── Response normaliser ──────────────────────────────────────────────────────
/**
 * Normalise VTU Africa's envelope to a consistent shape.
 *
 * VTU Africa success: code === 101 (may be number or string in their responses).
 * Status "Completed" on description is also checked where present.
 *
 * @param {object} raw - raw response body
 * @returns {{ ok, code, description, raw }}
 */
function normalise(raw) {
  const code        = Number(raw?.code ?? 0);
  const description = raw?.description ?? {};
  const ok          = code === 101;

  return { ok, code, description, raw };
}

// ─── PIN parser ───────────────────────────────────────────────────────────────
/**
 * Parse VTU Africa's "<=>"-delimited PIN string into structured objects.
 *
 * Single:   "WR23454<=>456786564"
 * Multiple: "WR23454<=>456786564,WR98765<=>123456789"
 *
 * @param {string|null} pinsString
 * @returns {Array<{ pin: string, serial: string }>}
 */
function parsePins(pinsString) {
  if (!pinsString || typeof pinsString !== 'string') return [];

  return pinsString
    .split(',')
    .map(pair => {
      const [pin = '', serial = ''] = pair.split('<=>');
      return { pin: pin.trim(), serial: serial.trim() };
    })
    .filter(p => p.pin || p.serial);
}

// ─── Webhook verification ─────────────────────────────────────────────────────
/**
 * Verify the authenticity of an incoming VTU Africa webhook payload.
 *
 * Defense-in-depth strategy (both layers must pass):
 *
 * Layer 1 — MD5 apikey check (VTU Africa's nominal scheme):
 *   VTU Africa sets payload.apikey = MD5(actual_api_key).
 *   We compute the same hash and compare.
 *
 * Layer 2 — Transaction Query verification (the real security boundary):
 *   We independently call VTU Africa's transaction-verify endpoint using
 *   the ref in the payload. We only trust the webhook if the authoritative
 *   query confirms the transaction is Completed. This prevents a forged
 *   webhook from triggering a wallet credit even if the MD5 check were
 *   somehow spoofed.
 *
 * @param {{ apikey: string, ref: string, [key: string]: any }} payload
 * @returns {Promise<{ valid: boolean, reason?: string, queryResult?: object }>}
 */
async function verifyWebhook(payload) {
  // ── Layer 1: MD5 apikey hash ──────────────────────────────────────────────
  const expectedHash = crypto
    .createHash('md5')
    .update(_getKey())
    .digest('hex');

  if (!payload?.apikey || payload.apikey !== expectedHash) {
    console.warn('[VTU Africa] Webhook rejected: invalid apikey hash');
    return { valid: false, reason: 'invalid_apikey_hash' };
  }

  // ── Layer 2: Transaction Query ────────────────────────────────────────────
  if (!payload?.ref) {
    console.warn('[VTU Africa] Webhook rejected: missing ref');
    return { valid: false, reason: 'missing_ref' };
  }

  let queryResult;
  try {
    queryResult = await queryTransaction({ ref: payload.ref });
  } catch (err) {
    console.error(
      `[VTU Africa] Webhook verification failed — Transaction Query threw for ref ${payload.ref}:`,
      err.message
    );
    return { valid: false, reason: 'query_error' };
  }

  const queryStatus = queryResult.description?.Status;
  if (!queryResult.ok || queryStatus !== 'Completed') {
    console.warn(
      '[VTU Africa] Webhook rejected: Transaction Query disagrees',
      {
        ref:           payload.ref,
        webhookStatus: payload.status,
        queryCode:     queryResult.code,
        queryStatus,
      }
    );
    return { valid: false, reason: 'transaction_query_mismatch' };
  }

  return { valid: true, queryResult };
}

// ─── Public API methods ───────────────────────────────────────────────────────

/**
 * Fetch current VTU Africa wallet balance.
 * Used by ops balance-monitor job and admin dashboard.
 */
async function getBalance() {
  const raw = await vtuGet('/balance/');
  return normalise(raw);
}

/**
 * Verify a JAMB candidate profile code.
 *
 * @param {{ profilecode: string, productCode: string }} opts
 */
async function verifyJambProfile({ profilecode, productCode }) {
  const raw = await vtuGet('/merchant-verify/', {
    serviceName:  'jamb',
    profilecode,
    product_code: productCode,
  });

  const n = normalise(raw);
  return {
    ...n,
    candidateName: n.description?.Customer        ?? null,
    profileCode:   n.description?.ProfileCode      ?? profilecode,
    productCode:   n.description?.product_code     ?? productCode,
  };
}

/**
 * Verify a betting platform user account.
 * Note: serviceName must be "Betting" with capital B — VTU Africa requires it.
 *
 * @param {{ service: string, userid: string }} opts
 */
async function verifyBetAccount({ service, userid }) {
  const raw = await vtuGet('/merchant-verify/', {
    serviceName: 'Betting',
    service:     service.toLowerCase(),
    userid,
  });

  const n = normalise(raw);
  return {
    ...n,
    customerName: n.description?.Customer_Name ?? n.description?.CustomerName ?? null,
    userId:       userid,
  };
}

/**
 * Purchase exam PINs (WAEC, NECO, NABTEB, JAMB).
 *
 * @param {{
 *   service: string, product_code: string, quantity: number, ref: string,
 *   phone?: string, profilecode?: string, sender?: string, webhookURL?: string
 * }} opts
 */
async function purchaseExamPin({
  service, product_code, quantity, ref,
  phone, profilecode, sender, webhookURL,
}) {
  const params = {
    service:      service.toLowerCase(),
    product_code,
    quantity,
    ref,
  };
  if (phone)       params.phone       = phone;
  if (profilecode) params.profilecode = profilecode;
  if (sender)      params.sender      = sender;
  if (webhookURL)  params.webhookURL  = webhookURL;

  const raw = await vtuGet('/exam-pin/', params);
  const n   = normalise(raw);

  return {
    ...n,
    pins:          parsePins(n.description?.pins ?? ''),
    amountCharged: parseFloat(n.description?.Amount_Charged   ?? 0) || 0,
    unitPrice:     parseFloat(n.description?.UnitPrice         ?? 0) || 0,
    commission:    parseFloat(n.description?.comi              ?? 0) || 0,
    referenceId:   n.description?.ReferenceID  ?? null,
    productName:   n.description?.ProductName  ?? null,
  };
}

/**
 * Fund a betting wallet.
 *
 * @param {{ service: string, userid: string, amount: number, ref: string, phone?: string, webhookURL?: string }} opts
 */
async function fundBetWallet({ service, userid, amount, ref, phone, webhookURL }) {
  const params = {
    service: service.toLowerCase(),
    userid,
    amount,
    ref,
  };
  if (phone)      params.phone      = phone;
  if (webhookURL) params.webhookURL = webhookURL;

  const raw = await vtuGet('/betpay/', params);
  const n   = normalise(raw);

  return {
    ...n,
    amountCharged: parseFloat(n.description?.Amount_Charged ?? 0) || 0,
    charge:        parseFloat(n.description?.Charge          ?? 0) || 0,
    commission:    parseFloat(n.description?.comi            ?? 0) || 0,
    referenceId:   n.description?.ReferenceID ?? null,
  };
}

/**
 * Verify Airtime2Cash service availability for a network.
 * Returns the VTU Africa phone number to transfer airtime to.
 *
 * @param {{ network: string }} opts
 */
/**
 * Resolve the transfer phone for a given network.
 * Priority:
 *   1. VTUAFRICA_A2C_PHONE_<NETWORK> env var (live portal phone from VTU Africa dashboard)
 *   2. In sandbox mode, fall back to the sandbox API key (for testing)
 * Returns null if neither is set.
 */
function _getA2CPhone(network) {
  const envKey  = `VTUAFRICA_A2C_PHONE_${network.toUpperCase().replace('-', '_')}`;
  const envPhone = process.env[envKey]?.trim() || null;
  if (envPhone) return envPhone;

  // Sandbox fallback: use sandbox key so testers can do end-to-end without a portal phone
  if (_cachedMode === 'sandbox') {
    return process.env.VTUAFRICA_SANDBOX_KEY?.trim() || null;
  }
  return null;
}

async function verifyAirtime2Cash({ network }) {
  // Try the live /merchant-verify/ endpoint first — in live mode VTU Africa may return
  // the portal phone number dynamically. If it fails or returns no phone, fall back to
  // the VTUAFRICA_A2C_PHONE_<NETWORK> env var (or sandbox key in sandbox mode).
  try {
    const raw = await vtuGet('/merchant-verify/', {
      serviceName: 'Airtime2Cash',
      network:     network.toLowerCase(),
    });
    const n             = normalise(raw);
    const transferPhone = n.description?.Phone_Number ?? null;

    if (transferPhone) {
      console.log(`[verifyAirtime2Cash] Got transferPhone from merchant-verify for ${network}: ${transferPhone}`);
      return {
        ...n,
        ok:            true,
        transferPhone,
        network:       n.description?.Network ?? network,
        message:       n.description?.message ?? null,
      };
    }

    // merchant-verify succeeded but returned no phone — log raw response for diagnosis
    console.warn(`[verifyAirtime2Cash] merchant-verify returned no Phone_Number for ${network}. code=${n.code} raw=`, JSON.stringify(n.raw));
  } catch (err) {
    console.warn(`[verifyAirtime2Cash] merchant-verify failed for ${network}: ${err.message} — falling back to configured phone`);
  }

  // Fallback: env-configured portal phone, or sandbox key in sandbox mode
  const transferPhone = _getA2CPhone(network);
  return {
    ok:            !!transferPhone,
    transferPhone,
    network,
    code:          0,
    message:       transferPhone ? null : `No transfer phone configured for ${network}. Set VTUAFRICA_A2C_PHONE_${network.toUpperCase()} in .env`,
  };
}

/**
 * Submit an Airtime-to-Cash conversion request.
 *
 * @param {{ network, sender, sendernumber, amount, sitephone, ref, webhookURL }} opts
 */
async function convertAirtime({ network, sender, sendernumber, amount, sitephone, ref, webhookURL }) {
  const params = {
    network:      network.toLowerCase(),
    sender,
    sendernumber,
    amount,
    ref,
  };
  if (sitephone)  params.sitephone  = sitephone;
  if (webhookURL) params.webhookURL = webhookURL;

  const raw = await vtuGet('/airtime-cash/', params);
  const n   = normalise(raw);

  return {
    ...n,
    amountPaid:  parseFloat(n.description?.AmountPaid         ?? 0) || 0,
    charge:      parseFloat(n.description?.Charge             ?? 0) || 0,
    referenceId: n.description?.ReferenceID ?? null,
    message:     n.description?.message     ?? null,
  };
}

/**
 * Query a transaction by our reference — used for reconciliation and webhook
 * verification (the authoritative source of truth for transaction status).
 *
 * @param {{ ref: string }} opts
 */
async function queryTransaction({ ref }) {
  const raw = await vtuGet('/transaction-verify/', { ref });
  const n   = normalise(raw);

  return {
    ...n,
    status:     n.description?.Status ?? null,
    pins:       parsePins(n.description?.pins ?? ''),
    commission: parseFloat(n.description?.comi ?? 0) || 0,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  // Lifecycle — call once at server boot
  validateStartup,

  // Public API methods
  getBalance,
  verifyJambProfile,
  verifyBetAccount,
  verifyAirtime2Cash,
  convertAirtime,
  purchaseExamPin,
  fundBetWallet,
  queryTransaction,

  // Webhook security
  verifyWebhook,

  // Utilities — exported for controllers and tests
  parsePins,
  normalise,
  redactKey,
};
