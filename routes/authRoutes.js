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
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.post(
  "/register",
  [
    body("firstName").notEmpty(),
    body("lastName").notEmpty(),
    body("phone").notEmpty().isMobilePhone(),
    body("password").isLength({ min: 6 }),
    body("email").isEmail(),
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

// ---- Phone OTP (post-login) ----

router.post("/phone/resend-otp", resendPhoneOtpPublic);

router.post(
  "/phone/verify-otp",
  [body("otp").isLength({ min: 6, max: 6 })],
  verifyPhoneOtpPublic
);

// Set PIN (protected)
router.post(
  "/set-Pin",
  protect,
  [
    body("pin")
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/),
  ],
  setPin
);

// Authenticated profile
router.get("/me", protect, me);

module.exports = router;
