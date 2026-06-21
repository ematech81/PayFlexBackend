'use strict';

const express  = require('express');
const router   = express.Router();
const { protect } = require('../middleware/auth');
const verifyPin   = require('../middleware/verifyPin');
const {
  getBanks, resolveAccount, initiateTransfer, getTransferStatus, getTransferHistory,
} = require('../controllers/vtuTransferController');

router.get('/banks',             protect, getBanks);
router.post('/resolve',          protect, resolveAccount);
router.post('/initiate',         protect, verifyPin, initiateTransfer);
router.get('/status/:reference', protect, getTransferStatus);
router.get('/history',           protect, getTransferHistory);

module.exports = router;
