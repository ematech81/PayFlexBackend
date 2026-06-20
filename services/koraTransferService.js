'use strict';

/**
 * KoraPay Disbursement Service
 * Handles bank-transfer payouts via the KoraPay Disbursement API.
 * Secret key is read from env at call-time and never logged.
 */

const axios = require('axios');

const KORA_BASE = 'https://api.korapay.com/merchant/api/v1';

const _auth = () => ({ Authorization: `Bearer ${process.env.KORA_SECRET_KEY}` });

const koraApi = axios.create({
  baseURL: KORA_BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

function _koraErr(err) {
  const msg = err.response?.data?.message || err.message || 'KoraPay request failed';
  const e   = new Error(msg);
  e.statusCode = err.response?.status || 502;
  e.koraData   = err.response?.data ?? null;
  return e;
}

/**
 * List Nigerian banks from KoraPay.
 * Returns array: [{ name, slug, code, nibss_bank_code, country }]
 */
async function getBanks() {
  try {
    const { data } = await koraApi.get('/misc/banks', { headers: _auth() });
    console.log('[koraTransfer] getBanks raw response keys:', Object.keys(data || {}));
    const list = Array.isArray(data?.data) ? data.data
                : Array.isArray(data?.data?.banks) ? data.data.banks
                : [];
    console.log(`[koraTransfer] getBanks returning ${list.length} banks`);
    return list;
  } catch (err) {
    console.error('[koraTransfer] getBanks error:', err.response?.status, JSON.stringify(err.response?.data));
    throw _koraErr(err);
  }
}

/**
 * Verify a bank account number and return the account name.
 * @param {{ bankCode: string, accountNumber: string }} params
 * Returns: { account_name, account_number, bank_code, bank_name }
 */
async function resolveAccount({ bankCode, accountNumber }) {
  try {
    const { data } = await koraApi.post('/misc/resolve-bank-account', {
      bank:    bankCode,
      account: accountNumber,
    }, { headers: _auth() });
    return data.data;
  } catch (err) {
    throw _koraErr(err);
  }
}

/**
 * Initiate a bank transfer (disbursement).
 * @param {{ reference, amount, bankCode, accountNumber, accountName, narration, customerEmail }} params
 * Returns KoraPay disbursement response data.
 */
async function disburse({ reference, amount, bankCode, accountNumber, accountName, narration, customerEmail }) {
  try {
    const { data } = await koraApi.post('/transactions/disburse', {
      reference,
      destination: {
        type:     'bank_account',
        amount,
        currency: 'NGN',
        narration: narration || 'PayFlex bank transfer',
        bank_account: {
          bank:    bankCode,
          account: accountNumber,
        },
        customer: {
          name:  accountName,
          email: customerEmail || 'noreply@payflex.ng',
        },
      },
    }, { headers: _auth() });
    return data.data;
  } catch (err) {
    throw _koraErr(err);
  }
}

/**
 * Fetch disbursement status by reference.
 * Returns KoraPay transaction data.
 */
async function getTransferStatus(reference) {
  try {
    const { data } = await koraApi.get(`/transactions/${reference}`, { headers: _auth() });
    return data.data;
  } catch (err) {
    throw _koraErr(err);
  }
}

module.exports = { getBanks, resolveAccount, disburse, getTransferStatus };
