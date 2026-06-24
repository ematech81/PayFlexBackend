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
  downloadStatusReport,
  searchBusiness,
  getHistory,
  registerLLC,
  handleWebhook,
  checkCompliance,
  validatePayload,
  devForceApprove,
} = require('../controllers/cacController');

// ── Webhook (no auth — raw body set in server.js before express.json()) ───────
router.post('/webhook', handleWebhook);

// ── Public (auth only) ────────────────────────────────────────────────────────
router.get('/prices',         protect, getPrices);
router.post('/validate-name', protect, validateName);
router.post('/compliance',    protect, checkCompliance);
router.post('/validate',      protect, validatePayload);
router.get('/history',        protect, getHistory);

// ── Registration ──────────────────────────────────────────────────────────────
router.post('/register/business-name', protect, verifyPin, registerBusinessName);
router.post('/register/llc',           protect, registerLLC);

// ── Dev / sandbox helpers (blocked in production by the handler itself) ───────
router.post('/dev/force-approve/:transactionRef', protect, devForceApprove);

// ── Per-registration actions ──────────────────────────────────────────────────
router.get('/registration/:transactionRef',                         protect, getRegistrationStatus);
router.post('/registration/:transactionRef/resubmit',              protect, resubmitRegistration);
router.post('/registration/:transactionRef/certificate',    protect, downloadCertificate);
router.post('/registration/:transactionRef/status-report', protect, downloadStatusReport);

// ── Business validation / search ──────────────────────────────────────────────
router.post('/search', protect, verifyPin, searchBusiness);

// ── LLC Registration (Steps 1–6) ──────────────────────────────────────────────
const {
  nameReservation,
  generateMemoObjects,
  analyseMemoObjects,
  createCompany,
  registerShares,
  registerAffiliate,
  getLlcSession,
  getLlcHistory,
  registerPsc,
} = require('../controllers/cacLlcController');

router.post('/llc/name-reservation',        protect, nameReservation);
router.post('/llc/memorandum/generate',     protect, generateMemoObjects);
router.post('/llc/memorandum/analyse',      protect, analyseMemoObjects);
router.post('/llc/company',                 protect, createCompany);
router.post('/llc/shares',                  protect, registerShares);
router.post('/llc/affiliate',               protect, registerAffiliate);
router.post('/llc/psc',                     protect, registerPsc);
router.get('/llc/registration/:sessionId',  protect, getLlcSession);
router.get('/llc/history',                  protect, getLlcHistory);

module.exports = router;
