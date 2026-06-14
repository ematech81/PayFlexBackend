'use strict';

const axios = require('axios');

const merpi = axios.create({
  baseURL: process.env.MERPI_BASE_URL || 'https://merpi.syticks.com/api',
  timeout: 30_000,
  headers: {
    'Content-Type':      'application/json',
    'Accept':            'application/json',
    'TransactionMedium': 'Mobile',
  },
});

// Read key at request time — never cached in module state
merpi.interceptors.request.use((config) => {
  const key = process.env.MERPI_SECRET_KEY;
  if (!key || !key.trim()) {
    const err = new Error('MERPI_SECRET_KEY is not configured.');
    err.statusCode = 503;
    throw err;
  }
  config.headers['Authorization'] = `Bearer ${key.trim()}`;
  return config;
});

// Redact key from error messages before they reach logs
merpi.interceptors.response.use(
  (res) => res,
  (err) => {
    const key = process.env.MERPI_SECRET_KEY;
    if (key && err.message) {
      err.message = err.message.split(key).join('[REDACTED]');
    }
    return Promise.reject(err);
  }
);

module.exports = merpi;
