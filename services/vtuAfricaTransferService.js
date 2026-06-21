'use strict';

const axios = require('axios');

const TIMEOUT_MS = 30_000;

function _getKey() {
  const mode = (process.env.VTUAFRICA_MODE || 'sandbox').toLowerCase().trim();
  return mode === 'live' ? process.env.VTUAFRICA_LIVE_KEY : process.env.VTUAFRICA_SANDBOX_KEY;
}

function _getBase() {
  const mode = (process.env.VTUAFRICA_MODE || 'sandbox').toLowerCase().trim();
  return mode === 'live'
    ? 'https://vtuafrica.com.ng/portal/api'
    : 'https://vtuafrica.com.ng/portal/api-test';
}

const VTU_BANKS = [
  { name: 'Access Bank Nigeria',             code: '044' },
  { name: 'Ecobank Nigeria Plc',             code: '050' },
  { name: 'Enterprise Bank Plc',             code: '084' },
  { name: 'Fidelity Bank Plc',               code: '070' },
  { name: 'First Bank Plc',                  code: '011' },
  { name: 'First City Monument Bank (FCMB)', code: '214' },
  { name: 'First Monie Wallet',              code: '309' },
  { name: 'Get Pay Microfinance Bank',       code: '215' },
  { name: 'Globus Bank Plc',                 code: '027' },
  { name: 'GTBank Plc',                      code: '058' },
  { name: 'Jaiz Bank',                       code: '301' },
  { name: 'Keystone Bank',                   code: '082' },
  { name: 'Opay Digital Services',           code: '305' },
  { name: 'PalmPay Limited',                 code: '306' },
  { name: 'Polaris Bank Plc',                code: '076' },
  { name: 'Providus Bank Plc',               code: '101' },
  { name: 'Stanbic IBTC Bank Plc',           code: '221' },
  { name: 'Standard Chartered Bank',         code: '068' },
  { name: 'Sterling Bank Plc',               code: '232' },
  { name: 'Union Bank of Nigeria Plc',       code: '032' },
  { name: 'Unity Bank Plc',                  code: '210' },
  { name: 'United Bank for Africa (UBA)',    code: '033' },
  { name: 'Wema Bank Plc',                   code: '035' },
  { name: 'Zenith Bank Plc',                 code: '057' },
];

function getBanks() {
  return VTU_BANKS;
}

async function resolveAccount({ bankCode, accountNo }) {
  try {
    const { data } = await axios.get(`${_getBase()}/merchant-verify/`, {
      params: { apikey: _getKey(), serviceName: 'BankTransfer', accountNo, bankcode: bankCode },
      timeout: TIMEOUT_MS,
    });
    if (data.code !== 101 || data.description?.Status !== 'Completed') {
      throw new Error(data.description?.message || 'Account verification failed');
    }
    return {
      account_name:   data.description.Customer,
      account_number: data.description.AccountNo,
      bank_name:      data.description.BankName,
      bank_code:      data.description.BankCode,
    };
  } catch (err) {
    const msg = err.response?.data?.description?.message || err.message || 'Account verification failed';
    const e   = new Error(msg);
    e.statusCode = err.response?.status || 502;
    throw e;
  }
}

async function sendMoney({ accountNo, bankcode, amount, sender, ref, webhookURL }) {
  try {
    const params = {
      apikey:   _getKey(),
      accountNo,
      bankcode,
      amount,
      sender:   sender || 'PayFlex',
      ref,
    };
    if (webhookURL) params.webhookURL = webhookURL;

    const { data } = await axios.get(`${_getBase()}/sendmoney/`, {
      params,
      timeout: TIMEOUT_MS,
    });

    if (data.code !== 101) {
      const e    = new Error(data.description?.message || 'Transfer failed');
      e.vtuData  = data;
      e.statusCode = 400;
      throw e;
    }
    return data.description;
  } catch (err) {
    if (err.vtuData) throw err;
    const msg = err.response?.data?.description?.message || err.message || 'VTU Africa transfer failed';
    const e   = new Error(msg);
    e.statusCode = err.response?.status || 502;
    e.vtuData    = err.response?.data ?? null;
    throw e;
  }
}

async function queryTransfer({ ref }) {
  return require('./vtuAfricaService').queryTransaction({ ref });
}

module.exports = { getBanks, VTU_BANKS, resolveAccount, sendMoney, queryTransfer };
