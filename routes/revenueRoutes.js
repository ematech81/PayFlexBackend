'use strict';

const express               = require('express');
const router                = express.Router();
const { protect, adminOnly } = require('../middleware/Auth');
const {
  getSummary,
  getDaily,
  getMonthly,
  getByService,
  getByProvider,
  getTopUsers,
  getPayForOthers,
  getWalletFloat,
} = require('../controllers/revenueController');

// All revenue endpoints are admin-only
router.use(protect, adminOnly);

router.get('/summary',        getSummary);
router.get('/daily',          getDaily);
router.get('/monthly',        getMonthly);
router.get('/by-service',     getByService);
router.get('/by-provider',    getByProvider);
router.get('/top-users',      getTopUsers);
router.get('/pay-for-others', getPayForOthers);
router.get('/wallet-float',   getWalletFloat);

module.exports = router;
