'use strict';

const express   = require('express');
const router    = express.Router();
const { protect }  = require('../middleware/auth');
const verifyPin    = require('../middleware/verifyPin');
const {
  getCatalog,
  verifyJambProfile,
  purchase,
  getHistory,
} = require('../controllers/examPinController');

// Public within auth — any logged-in user can view the catalog
router.get('/catalog', protect, getCatalog);

// JAMB profile code verification (no PIN required — this is just a lookup)
router.post('/verify-jamb', protect, verifyJambProfile);

// Purchase — requires both JWT auth and transaction PIN
router.post('/purchase', protect, verifyPin, purchase);

// Transaction history
router.get('/history', protect, getHistory);

module.exports = router;
