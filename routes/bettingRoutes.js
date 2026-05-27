'use strict';

const express      = require('express');
const router       = express.Router();
const { protect }  = require('../middleware/auth');
const verifyPin    = require('../middleware/verifyPin');
const {
  getPlatforms,
  verifyAccount,
  fund,
  getHistory,
} = require('../controllers/bettingController');

// Platform list — any authenticated user
router.get('/platforms', protect, getPlatforms);

// Bet account verification — no PIN needed (lookup only)
router.post('/verify-account', protect, verifyAccount);

// Fund betting wallet — requires JWT auth + transaction PIN
router.post('/fund', protect, verifyPin, fund);

// Transaction history
router.get('/history', protect, getHistory);

module.exports = router;
