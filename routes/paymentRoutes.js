// routes/paymentRoutes.js

const express = require("express");
const { body, validationResult } = require("express-validator");
const router = express.Router();
const bcrypt = require("bcryptjs");
const User = require("../models/user");
const { protect } = require("../middleware/auth");
const verifyPin = require("../middleware/verifyPin");
const {
  // Core
  makePayment,
  verifyTransaction,
  verfyTransactionPin,
  
  // Data
  getDataPlans,
  buyDataBundle,
  
  // Electricity
  verifyMeterNumber,
  payElectricityBill,
  
} = require("../controllers/paymentController");
const axios = require("axios");



// ✅ Get Data Plans - NO AUTH REQUIRED
router.get("/data-plans", getDataPlans) 

// ✅ Buy Airtime
router.post("/buy-airtime", protect, async (req, res, next) => {
  try {
    const { phoneNumber, amount, network, pin } = req.body;

    if (!phoneNumber || !amount || !network || !pin) {
      return res.status(400).json({ 
        success: false,
        message: "Missing required fields" 
      });
    }

    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: "Authentication required" 
      });
    }

    const userId = req.user.id || req.user._id;
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: "User not found" 
      });
    }

    if (!user.transactionPinHash) {
      return res.status(403).json({ 
        success: false,
        message: "Transaction PIN not set" 
      });
    }
    
    const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);
    if (!isMatch) {
      return res.status(403).json({ 
        success: false,
        message: "Invalid Transaction PIN" 
      });
    }

    // ✅ Skip balance check in sandbox
    const isSandbox = process.env.VTPASS_ENV === 'sandbox';
    
    if (!isSandbox && user.walletBalance < amount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance"
      });
    }

    const serviceID = `${network.toLowerCase()}`;
    const response = await makePayment(req, res, {
      serviceID,
      phoneNumber,
      amount,
      userId: user._id,
    });
    
    // ✅ Only deduct in production
    if (response.success && !isSandbox) {
      user.walletBalance -= amount;
      await user.save();
    }
    
    res.json(response);
  } catch (err) {
    console.error('Buy airtime error:', err);
    next(err);
  }
});



/**
 * Buy Data Bundle
 * POST /api/payments/buy-data
 * Protected route - requires authentication and PIN
 */
router.post(
  "/buy-data",
  protect,
  [
    // Validation middleware
    body("phoneNumber")
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^\d{11}$/)
      .withMessage("Phone number must be 11 digits"),
    body("amount")
      .notEmpty()
      .withMessage("Amount is required")
      .isNumeric()
      .withMessage("Amount must be a number"),
    body("network")
      .notEmpty()
      .withMessage("Network is required"),
    body("variation_code")
      .notEmpty()
      .withMessage("Variation code is required"),
    body("pin")
      .notEmpty()
      .withMessage("Transaction PIN is required")
      .matches(/^\d{4}$/)
      .withMessage("PIN must be 4 digits"),
  ],
  (req, res, next) => {
    // Validation error handler
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        errors: errors.array(),
      });
    }
    
    // Call controller
    next();
  },
  buyDataBundle  
);

// Verify Transaction Pin
router.post(
  "/verify-transaction-pin",
  protect,
  [
    body("pin")
      .notEmpty()
      .withMessage("Transaction PIN is required")
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage("Transaction PIN must be exactly 4 digits"),
  ],
  verfyTransactionPin
);



/**
  ELECTRICITY PAYMENT ROUTES
 */

/**
 * Verify Meter Number
 * POST /api/payments/verify-meter
 * Protected route - requires authentication
 */
router.post(
  "/verify-meter",
  protect,
  [
    body("meterNumber")
      .notEmpty()
      .withMessage("Meter number is required")
      .matches(/^\d{10,13}$/)
      .withMessage("Meter number must be 10-13 digits"),
    body("disco")
      .notEmpty()
      .withMessage("Distribution company is required"),
    body("meterType")
      .notEmpty()
      .withMessage("Meter type is required")
      .isIn(["prepaid", "postpaid"])
      .withMessage("Meter type must be either prepaid or postpaid"),
  ],
  verifyMeterNumber
);

/**
 * Pay Electricity Bill
 * POST /api/payments/pay-electricity
 * Protected route - requires authentication and PIN
 */
router.post(
  "/pay-electricity",
  protect,
  [
    body("meterNumber")
      .notEmpty()
      .withMessage("Meter number is required")
      .matches(/^\d{10,13}$/)
      .withMessage("Meter number must be 10-13 digits"),
    body("disco")
      .notEmpty()
      .withMessage("Distribution company is required"),
    body("meterType")
      .notEmpty()
      .withMessage("Meter type is required")
      .isIn(["prepaid", "postpaid"])
      .withMessage("Meter type must be either prepaid or postpaid"),
    body("amount")
      .notEmpty()
      .withMessage("Amount is required")
      .isNumeric()
      .withMessage("Amount must be a number")
      .custom((value) => {
        const amount = Number(value);
        if (amount < 500) {
          throw new Error("Minimum amount is ₦500");
        }
        if (amount > 100000) {
          throw new Error("Maximum amount is ₦100,000");
        }
        return true;
      }),
    body("phone")
      .optional()
      .matches(/^\d{11}$/)
      .withMessage("Phone number must be 11 digits"),
    body("pin")
      .notEmpty()
      .withMessage("Transaction PIN is required")
      .matches(/^\d{4}$/)
      .withMessage("PIN must be 4 digits"),
  ],
  payElectricityBill
);

/**
 * Get Electricity Tariff Info
 * GET /api/payments/electricity/tariff
 * Public route
 */
router.get("/electricity/tariff", async (req, res) => {
  try {
    const { disco } = req.query;

    if (!disco) {
      return res.status(400).json({
        success: false,
        message: "Distribution company is required",
      });
    }

    // Return tariff information (you can customize this)
    const tariffInfo = {
      ekedc: {
        prepaid: { minAmount: 500, maxAmount: 100000 },
        postpaid: { minAmount: 500, maxAmount: 100000 },
      },
      ikedc: {
        prepaid: { minAmount: 500, maxAmount: 100000 },
        postpaid: { minAmount: 500, maxAmount: 100000 },
      },
      // Add other DISCOs as needed
    };

    res.json({
      success: true,
      data: tariffInfo[disco.toLowerCase()] || {
        prepaid: { minAmount: 500, maxAmount: 100000 },
        postpaid: { minAmount: 500, maxAmount: 100000 },
      },
    });
  } catch (error) {
    console.error('Tariff Info Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tariff information',
    });
  }
});

module.exports = router;



