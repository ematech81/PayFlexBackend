
const express = require('express');
const router = express.Router();
const payStackController = require('../controllers/payStackController');
const { body, validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const User = require("../models/user");
const { protect } = require("../middleware/auth");

router.post('/initialize', protect, payStackController.initializePayment);
router.get('/verify/:reference', protect, payStackController.verifyPayment);
router.post('/webhook', payStackController.handleWebhook);
router.get('/history', protect, payStackController.getPaymentHistory);

module.exports = router;