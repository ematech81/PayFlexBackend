const express = require("express");
const { body } = require("express-validator");

const {
  register,
  login,

  // setPin,
  me,
  // sendPhoneOtp,
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

router.post(
  "/login",
  [body("emailOrPhone").notEmpty(), body("password").notEmpty()],
  login
);

// ---- Phone OTP (post-login) ----
// router.post("/phone/send-otp", protect, sendPhoneOtp);
router.post("/phone/resend-otp", protect, resendPhoneOtpPublic);
router.post(
  "/phone/verify-otp",
  protect,
  [body("otp").isLength({ min: 6, max: 6 })],
  verifyPhoneOtpPublic
);

// Authenticated profile
router.get("/me", protect, me);

module.exports = router;
