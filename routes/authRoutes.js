// routes/auth.js
const express = require("express");
const { body } = require("express-validator");
const {
  register,
  login,
  setPin,
  me,
  verifyLoginPin,
  resendPhoneOtpPublic,
  verifyPhoneOtpPublic,
  setTransactionPin,
  resetTransactionPin,
  resetLoginPin,
  // New controllers (you'll create)
  forgotLoginPin,
  verifyResetCode,
  updateRequirePinOnOpen,
  setPinAfterReset,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

const router = express.Router();

/* ========================================
   PUBLIC ROUTES
   ======================================== */

// 1. Register
router.post(
  "/register",
  [
    body("firstName").notEmpty().withMessage("First name is required"),
    body("lastName").notEmpty().withMessage("Last name is required"),
    body("phone").isMobilePhone().withMessage("Valid phone number is required"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
    body("email").optional().isEmail().withMessage("Valid email is required"),
  ],
  register
);

// 2. Login (phone + 6-digit PIN)
router.post(
  "/login",
  [
    body("phone").notEmpty().withMessage("Phone number is required"),
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("PIN must be exactly 6 digits"),
    body("deviceId").notEmpty().withMessage("Device ID is required"),
  ],
  login
);

// 3. Verify Login PIN (public – used before full login)
router.post(
  "/verify-login-pin",
  [
    body("phone").notEmpty().withMessage("Phone number is required"),
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("PIN must be exactly 6 digits"),
  ],
  verifyLoginPin
);

// 4. Phone OTP
router.post("/phone/resend-otp", resendPhoneOtpPublic);
router.post(
  "/phone/verify-otp",
  [
    body("phone").notEmpty().withMessage("Phone is required"),
    body("otp").isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits"),
  ],
  verifyPhoneOtpPublic
);

/* ========================================
   FORGOT PIN FLOW (PUBLIC)
   ======================================== */

// 5. Trigger Forgot PIN → sends OTP to phone + email
router.post(
  "/forgot-pin",
  [body("phone").notEmpty().withMessage("Phone is required")],
  forgotLoginPin
);

// 6. Verify Reset Code → returns short-lived reset token
router.post(
  "/verify-reset-code",
  [
    body("phone").notEmpty(),
    body("code").isLength({ min: 6, max: 6 }).withMessage("Code must be 6 digits"),
  ],
  verifyResetCode
);

// 7. Set new PIN after reset (uses reset token)
router.post(
  "/set-pin-after-reset",
  [
    body("resetToken").notEmpty(),
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("PIN must be 6 digits"),
  ],
  setPinAfterReset // new controller
);

/* ========================================
   PROTECTED ROUTES
   ======================================== */

// 8. Set Login PIN (first time after signup)
router.post(
  "/set-pin",
  protect,
  [
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("PIN must be exactly 6 digits"),
  ],
  setPin
);

// 9. Update "Require PIN on open"
router.post(
  "/update-require-pin",
  protect,
  [body("requirePin").isBoolean()],
  updateRequirePinOnOpen
);

// 10. Transaction PIN
router.post(
  "/set-transaction-pin",
  protect,
  [
    body("pin")
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage("Transaction PIN must be 4 digits"),
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
      .withMessage("Transaction PIN must be 4 digits"),
    body("otp").isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits"),
  ],
  resetTransactionPin
);

// 11. Reset Login PIN (old – keep for backward compat)
router.post(
  "/reset-login-pin",
  protect,
  [
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("Login PIN must be 6 digits"),
    body("otp").isLength({ min: 6, max: 6 }).withMessage("OTP must be 6 digits"),
  ],
  resetLoginPin
);

// 12. Me
router.get("/me", protect, me);

module.exports = router;