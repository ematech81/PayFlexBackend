const express = require("express");
const { body } = require("express-validator");

const {
  register,
  login,
  setPin,
  me,
  loginPin,
  resendPhoneOtpPublic,
  verifyPhoneOtpPublic,
  setTransactionPin,
  resetTransactionPin,
  resetLoginPin,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.post(
  "/register",
  [
    body("firstName").notEmpty().withMessage("First name is required"),
    body("lastName").notEmpty().withMessage("Last name is required"),
    body("phone")
      .notEmpty()
      .isMobilePhone()
      .withMessage("Valid phone number is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("email").isEmail().withMessage("Valid email is required"),
  ],
  register
);

// Login (no protect middleware)
router.post(
  "/login",
  [
    body("phone").notEmpty().withMessage("Phone number is required"),
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("PIN must be exactly 6 digits"),
  ],
  login
);

// PIN-only login (protected)
router.post(
  "/login-pin",
  protect,
  [
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("PIN must be exactly 6 digits"),
  ],
  loginPin
);

// Phone OTP (post-login)
router.post("/phone/resend-otp", resendPhoneOtpPublic);

router.post(
  "/phone/verify-otp",
  [
    body("otp")
      .isLength({ min: 6, max: 6 })
      .withMessage("OTP must be 6 digits"),
  ],
  verifyPhoneOtpPublic
);

// Set PIN (protected)
router.post(
  "/set-Pin",
  protect,
  [
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("PIN must be exactly 6 digits"),
  ],
  setPin
);

// Set Transaction PIN (protected)
router.post(
  "/set-transaction-pin",
  protect,
  [
    body("pin")
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage("Transaction PIN must be exactly 4 digits"),
  ],
  setTransactionPin
);

router.post(
  "/reset-transaction-pin",
  protect,
  [
    body("pin")
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage("Transaction PIN must be exactly 4 digits"),
    body("otp")
      .isLength({ min: 6, max: 6 })
      .withMessage("OTP must be 6 digits"),
  ],
  resetTransactionPin
);

router.post(
  "/reset-login-pin",
  protect,
  [
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("Login PIN must be exactly 6 digits"),
    body("otp")
      .isLength({ min: 6, max: 6 })
      .withMessage("OTP must be 6 digits"),
  ],
  resetLoginPin
);

// Authenticated profile
router.get("/me", protect, me);

module.exports = router;
