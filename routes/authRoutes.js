

const express = require("express");
const { body, validationResult } = require("express-validator");
const {
  register,
  login,
  verifyDeviceOtp,
  resendDeviceOtp,
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
  addTestFunds,
  changeLoginPin
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const validate  = require("../middleware/validate");


const router = express.Router();

/* ========================================
   PUBLIC ROUTES
   ======================================== */

   
   // 1. Register
   router.post(
     "/register",
     [
       body("firstName")
         .trim()
         .notEmpty()
         .withMessage("First name is required")
         .isLength({ min: 2, max: 50 })
         .withMessage("First name must be between 2 and 50 characters"),
       
       body("lastName")
         .trim()
         .notEmpty()
         .withMessage("Last name is required")
         .isLength({ min: 2, max: 50 })
         .withMessage("Last name must be between 2 and 50 characters"),
       
       body("phone")
         .trim()
         .notEmpty()
         .withMessage("Phone number is required")
         .matches(/^(\+?234|0)[789]\d{9}$/)
         .withMessage("Please enter a valid Nigerian phone number (e.g., 08012345678 or +2348012345678)"),
       
       body("password")
         .notEmpty()
         .withMessage("Password is required")
         .isLength({ min: 6 })
         .withMessage("Password must be at least 6 characters"),
       
       body("email")
         .optional({ checkFalsy: true })
         .trim()
         .isEmail()
         .withMessage("Please enter a valid email address")
         .normalizeEmail(),
     ],
     validate,
     register
   );


// 4. Phone OTP
// router.post("/phone/resend-otp", resendPhoneOtpPublic);

// 2. Verify Phone OTP (after registration)
router.post(
  "/phone/verify-otp",
  [
    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^(\+?234|0)[789]\d{9}$/)
      .withMessage("Please enter a valid Nigerian phone number"),
    
    body("otp")
      .trim()
      .notEmpty()
      .withMessage("OTP is required")
      .matches(/^\d{6}$/)
      .withMessage("OTP must be exactly 6 digits"),
    
    body("deviceId")
      .optional()
      .isString()
      .trim()
      .withMessage("Device ID must be a string"),
  ],
  validate,
  verifyPhoneOtpPublic
);



router.post(
  "/phone/resend-otp",
  [
    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^(\+?234|0)[789]\d{9}$/)
      .withMessage("Please enter a valid Nigerian phone number"),
    
    body("otp")
      .trim()
      .notEmpty()
      .withMessage("OTP is required")
      .matches(/^\d{6}$/)
      .withMessage("OTP must be exactly 6 digits"),
  ],
  validate,
  resendPhoneOtpPublic
);



// LOGIN & DEVICE VERIFICATION ROUTES

// 4. Login (with device detection)
router.post(
  "/login",
  [
    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^(\+?234|0)[789]\d{9}$/)
      .withMessage("Please enter a valid Nigerian phone number"),
    
    body("pin")
      .trim()
      .notEmpty()
      .withMessage("PIN is required")
      .matches(/^\d{6}$/)
      .withMessage("PIN must be exactly 6 digits"),
    
    body("deviceId")
      .trim()
      .isString()
      .notEmpty()
      .withMessage("Device ID is required"),
  ],
  validate,
  login
);

// 5. Verify Device OTP (for new devices)
router.post(
  "/verify-device-otp",
  [
    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^(\+?234|0)[789]\d{9}$/)
      .withMessage("Please enter a valid Nigerian phone number"),
    
    body("otp")
      .trim()
      .notEmpty()
      .withMessage("OTP is required")
      .matches(/^\d{6}$/)
      .withMessage("OTP must be exactly 6 digits"),
    
    body("deviceId")
      .trim()
      .notEmpty()
      .withMessage("Device ID is required"),
  ],
  validate,
  verifyDeviceOtp
);

// 6. Resend Device OTP
router.post(
  "/resend-device-otp",
  [
    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^(\+?234|0)[789]\d{9}$/)
      .withMessage("Please enter a valid Nigerian phone number"),
  ],
  validate,
  resendDeviceOtp
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
  validate,
  verifyLoginPin
);



  // FORGOT PIN FLOW (PUBLIC)
// 5. Trigger Forgot PIN → sends OTP to phone + email
router.post(
  "/forgot-pin",
  [body("phone").notEmpty().withMessage("Phone is required")],
  validate,
  forgotLoginPin
);

// 6. Verify Reset Code → returns short-lived reset token
router.post(
  "/verify-reset-code",
  [
    body("phone").notEmpty(),
    body("code").isLength({ min: 6, max: 6 }).withMessage("Code must be 6 digits"),
  ],
  validate,
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
  validate,
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

// =================================
// set transaction pin logic
// =================================
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


// =================================
// reset login pin logic
// =================================

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

// =================================
//change login pin logic
// =================================
router.post(
  "/change-login-pin",
  protect,
  [
    body("currentPin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("Current PIN must be 6 digits"),
    body("newPin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage("New PIN must be 6 digits"),
  ],
  validate,
  changeLoginPin
);



// wallet funding routes
router.post(
  "/add-test-funds",
 protect,
 [
  body("amount")
    .isNumeric()
    .withMessage("Amount must be a number")
    .custom(value => value > 0)
    .withMessage("Amount must be positive"),
 ],
  addTestFunds
);

// 12. Me
router.get("/me", protect, me);

module.exports = router; 