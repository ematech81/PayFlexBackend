const express = require("express");
const { body } = require("express-validator");

const {
  register,
  login,
  resendEmailOtp,
  verifyEmailOtp,
  // setPin,
  me,
  sendPhoneOtp,
  resendPhoneOtp,
  verifyPhoneOtp,
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

router.post(
  "/login",
  [body("emailOrPhone").notEmpty(), body("password").notEmpty()],
  login
);

router.post("/resend-email-otp", [body("userId").notEmpty()], resendEmailOtp);
router.post(
  "/verify-email-otp",
  [body("userId").notEmpty(), body("otp").isLength({ min: 4 })],
  verifyEmailOtp
);

// ---- Phone OTP (post-login) ----
router.post("/phone/send-otp", protect, sendPhoneOtp);
router.post("/phone/resend-otp", protect, resendPhoneOtp);
router.post(
  "/phone/verify-otp",
  protect,
  [body("otp").isLength({ min: 6, max: 6 })],
  verifyPhoneOtp
);

// Authenticated profile
router.get("/me", protect, me);

module.exports = router;
