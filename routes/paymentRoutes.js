// routes/paymentRoutes.js

const express = require("express");
const { body, validationResult } = require("express-validator");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
  // Core
  buyAirtime,
  verfyTransactionPin,
  
  // Data
  getDataPlans,
  buyDataBundle,
  
  // Electricity
  verifyMeterNumber,
  payElectricityBill,
  // testVTPassConnection,

  // Tv Subscription
  getTVBouquets,
  verifySmartcard,
  subscribeTVBouquet,
  renewTVSubscription,

  getTransactionByReference,

// get transation history
  getTransactionHistory,
  getTransactionStats
  
} = require("../controllers/paymentController");

// Test endpoint
// router.get('/test-vtpass', protect, testVTPassConnection);

// ✅ Buy Airtime
router.post(
  "/buy-airtime",
  protect,
  [
    body("phoneNumber")
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^\d{11}$/)
      .withMessage("Phone number must be 11 digits"),
    body("network")  // ✅ ADDED: Validate network field
      .notEmpty()
      .withMessage("Network provider is required")
      .isIn(["mtn", "airtel", "glo", "9mobile", "etisalat"])
      .withMessage("Invalid network provider"),
    body("amount")
      .notEmpty()
      .withMessage("Amount is required")
      .isNumeric()
      .withMessage("Amount must be a number")
      .custom((value) => {
        const amount = Number(value);
        if (amount < 50) {
          throw new Error("Minimum amount is ₦50");
        }
        if (amount > 50000) {
          throw new Error("Maximum amount is ₦50,000");
        }
        return true;
      }),
    body("pin")
      .notEmpty()
      .withMessage("Transaction PIN is required")
      .matches(/^\d{4}$/)
      .withMessage("PIN must be 4 digits"),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        errors: errors.array(),
      });
    }
    next();
  },
  buyAirtime
);

// ✅ Get Data Plans
router.get("/data-plans", protect, getDataPlans);


// ✅ Buy Data Bundle
router.post(
  "/buy-data",
  protect,
  [
    body("phoneNumber")
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^\d{11}$/)
      .withMessage("Phone number must be 11 digits"),
    body("network")  // ✅ ADDED: Validate network field
      .notEmpty()
      .withMessage("Network provider is required")
      .isIn(["mtn", "airtel", "glo", "9mobile", "etisalat"])
      .withMessage("Invalid network provider"),
    body("amount")
      .notEmpty()
      .withMessage("Amount is required")
      .isNumeric()
      .withMessage("Amount must be a number"),
    body("variation_code")
      .notEmpty()
      .withMessage("Data plan is required"),
    body("pin")
      .notEmpty()
      .withMessage("Transaction PIN is required")
      .matches(/^\d{4}$/)
      .withMessage("PIN must be 4 digits"),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        errors: errors.array(),
      });
    }
    next();
  },
  buyDataBundle  
);

// ✅ Verify Transaction Pin
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
 * ELECTRICITY PAYMENT ROUTES
 */

// ✅ Verify Meter Number
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
      .withMessage("Distribution company is required")
      .isIn([
        "ikedc", "ekedc", "kedco", "phed", "jed", 
        "ibedc", "kaedco", "aedc", "eedc", "bedc", 
        "aba", "yedc"
      ])
      .withMessage("Invalid distribution company"),
    body("meterType")
      .notEmpty()
      .withMessage("Meter type is required")
      .isIn(["prepaid", "postpaid"])
      .withMessage("Meter type must be either prepaid or postpaid"),
  ],
  verifyMeterNumber
);

// ✅ Pay Electricity Bill
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
      .withMessage("Distribution company is required")
      .isIn([
        "ikedc", "ekedc", "kedco", "phed", "jed", 
        "ibedc", "kaedco", "aedc", "eedc", "bedc", 
        "aba", "yedc"
      ])
      .withMessage("Invalid distribution company"),
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
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        errors: errors.array(),
      });
    }
    next();
  },
  payElectricityBill
);

// ✅ Get Electricity Tariff Info
router.get("/electricity/tariff", async (req, res) => {
  try {
    const { disco } = req.query;

    if (!disco) {
      return res.status(400).json({
        success: false,
        message: "Distribution company is required",
      });
    }

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



// ============================================
// TV SUBSCRIPTION ROUTES
// ============================================


// Get TV Bouquets/Packages
router.get("/tv-plans", protect, getTVBouquets);

// Verify Smartcard Number
router.post(
  "/verify-smartcard",
  protect,
  [
    body("smartcardNumber")
      .notEmpty()
      .withMessage("Smartcard number is required")
      .matches(/^\d{10,11}$/)
      .withMessage("Smartcard number must be 10-11 digits"),
    body("provider")
      .notEmpty()
      .withMessage("TV provider is required")
      .isIn(["dstv", "gotv", "startimes", "showmax"])
      .withMessage("Invalid TV provider"),
  ],
  verifySmartcard
);

// Subscribe TV (New Purchase/Change Bouquet)
router.post(
  "/subscribe-tv",
  protect,
  [
    body("smartcardNumber")
      .notEmpty()
      .withMessage("Smartcard number is required")
      .matches(/^\d{10,11}$/)
      .withMessage("Smartcard number must be 10-11 digits"),
    body("provider")
      .notEmpty()
      .withMessage("TV provider is required")
      .isIn(["dstv", "gotv", "startimes", "showmax"])
      .withMessage("Invalid TV provider"),
    body("variation_code")
      .notEmpty()
      .withMessage("Bouquet selection is required"),
    body("amount")
      .notEmpty()
      .withMessage("Amount is required")
      .isNumeric()
      .withMessage("Amount must be a number")
      .custom((value) => {
        const amount = Number(value);
        if (amount < 100) {
          throw new Error("Minimum amount is ₦100");
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
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        errors: errors.array(),
      });
    }
    next();
  },
  subscribeTVBouquet
);

// Renew TV Subscription
router.post(
  "/renew-tv",
  protect,
  [
    body("smartcardNumber")
      .notEmpty()
      .withMessage("Smartcard number is required")
      .matches(/^\d{10,11}$/)
      .withMessage("Smartcard number must be 10-11 digits"),
    body("provider")
      .notEmpty()
      .withMessage("TV provider is required")
      .isIn(["dstv", "gotv", "startimes", "showmax"])
      .withMessage("Invalid TV provider"),
    body("amount")
      .notEmpty()
      .withMessage("Amount is required")
      .isNumeric()
      .withMessage("Amount must be a number")
      .custom((value) => {
        const amount = Number(value);
        if (amount < 100) {
          throw new Error("Minimum amount is ₦100");
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
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: errors.array()[0].msg,
        errors: errors.array(),
      });
    }
    next();
  },
  renewTVSubscription
);



// ✅ Specific routes FIRST
router.get('/transactions/history', protect, getTransactionHistory);
router.get('/transactions/stats', protect, getTransactionStats);

// ✅ Parameterized route LAST
router.get('/transactions/:reference', protect, getTransactionByReference);

module.exports = router;
