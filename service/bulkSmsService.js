'use strict';

const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL  = () => process.env.BULKSMS_BASE_URL  || 'https://www.bulksmsnigeria.com/api/v2';
const API_TOKEN = () => process.env.BULKSMS_API_TOKEN;
const SENDER_ID = () => process.env.BULKSMS_SENDER_ID || 'PayFlex';

// ── BulkSMS Nigeria error code → user-friendly message ───────────────────────
const BSNG_ERRORS = {
  'BSNG-1001': 'SMS service authentication failed — contact support',
  'BSNG-3001': 'SMS service temporarily unavailable — try again shortly',
  'BSNG-3004': 'Too many requests. Please wait and try again.',
  'BSNG-2006': 'Invalid phone number',
};

const friendlyError = (code) =>
  BSNG_ERRORS[code] || 'Could not send your access key. Please try again.';

// ── generateAlphanumericOTP ───────────────────────────────────────────────────
// Generates a 6-character code that always contains at least one letter
// and at least one digit. Uses an unambiguous character set (no 0/O/1/I/L).
const generateAlphanumericOTP = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let otp = '';
  while (true) {
    otp = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
    const hasLetter = /[A-Z]/.test(otp);
    const hasNumber = /[0-9]/.test(otp);
    if (hasLetter && hasNumber) break;
  }
  return otp;
};

// ── formatNigerianNumber ──────────────────────────────────────────────────────
// BulkSMS Nigeria expects numbers WITHOUT the + prefix:
//   08012345678       → 2348012345678
//   +2348012345678    → 2348012345678
//   2348012345678     → 2348012345678
const formatNigerianNumber = (phone) => {
  const cleaned = String(phone).replace(/[\s\-\.]/g, '');

  if (cleaned.startsWith('+234')) return cleaned.slice(1); // remove +
  if (cleaned.startsWith('234'))  return cleaned;
  if (cleaned.startsWith('0'))    return `234${cleaned.slice(1)}`;

  // bare digits e.g. 8012345678
  if (/^\d{10}$/.test(cleaned))   return `234${cleaned}`;

  throw new Error(`Cannot normalise phone number for BulkSMS: "${phone}"`);
};

// ── sendOTP ───────────────────────────────────────────────────────────────────
// Sends a single access-key SMS to one Nigerian number via BulkSMS Nigeria API v2.
const sendOTP = async (phoneNumber, otpCode) => {
  try {
    const to      = formatNigerianNumber(phoneNumber);
    const message = `Hi, your PayFlex access key is ${otpCode}. Valid for 10 mins. Keep it private.`;

    const { data } = await axios.post(
      `${BASE_URL()}/sms`,
      {
        from:    SENDER_ID(),
        to,
        body:    message,
        gateway: 'direct-refund',
      },
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN()}`,
          'Content-Type': 'application/json',
          Accept:         'application/json',
        },
        timeout: 15000,
      }
    );

    // BulkSMS Nigeria success code
    if (data?.code === 'BSNG-0000') {
      return { success: true, messageId: data.message_id };
    }

    // Known failure code
    const errMsg = friendlyError(data?.code);
    console.error(`[BulkSMS] error code ${data?.code}: ${data?.description || '(no description)'}`);
    throw new Error(errMsg);

  } catch (err) {
    // Re-throw user-friendly errors we already built above
    if (err.message && Object.values(BSNG_ERRORS).includes(err.message)) {
      throw err;
    }
    if (err.message === 'Could not send your access key. Please try again.') {
      throw err;
    }

    // Axios network / timeout errors
    console.error('[BulkSMS] network/request error:', err.message);
    throw new Error('Could not send your access key. Please try again.');
  }
};

module.exports = { generateAlphanumericOTP, formatNigerianNumber, sendOTP };
