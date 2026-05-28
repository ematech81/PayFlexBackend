'use strict';

const express     = require('express');
const router      = express.Router();
const { protect } = require('../middleware/auth');
const verifyPin   = require('../middleware/verifyPin');
const {
  getPrices,
  validateName,
  registerBusinessName,
  getRegistrationStatus,
  resubmitRegistration,
  downloadCertificate,
  searchBusiness,
  getHistory,
  registerLLC,
  handleWebhook,
} = require('../controllers/cacController');

// ── Webhook (no auth — raw body set in server.js before express.json()) ───────
router.post('/webhook', handleWebhook);

// ── Public (auth only) ────────────────────────────────────────────────────────
router.get('/prices',        protect, getPrices);
router.post('/validate-name', protect, validateName);
router.get('/history',        protect, getHistory);

// ── Registration ──────────────────────────────────────────────────────────────
router.post('/register/business-name', protect, verifyPin, registerBusinessName);
router.post('/register/llc',           protect, registerLLC);

// ── Per-registration actions ──────────────────────────────────────────────────
router.get('/registration/:transactionRef',                         protect, getRegistrationStatus);
router.post('/registration/:transactionRef/resubmit',              protect, resubmitRegistration);
router.post('/registration/:transactionRef/certificate', protect, verifyPin, downloadCertificate);

// ── Business validation / search ──────────────────────────────────────────────
router.post('/search', protect, verifyPin, searchBusiness);

module.exports = router;
