'use strict';

const express  = require('express');
const router   = express.Router();
const { protect } = require('../middleware/Auth');
const { getMySubscription, upgradeSubscription } = require('../controllers/subscriptionController');

router.get('/me',      protect, getMySubscription);
router.post('/upgrade', protect, upgradeSubscription);

module.exports = router;
