const express = require("express");
const crypto = require("crypto");
const twilio = require("twilio");
const User = require("../models/user");
const { body, validationResult } = require("express-validator");
const router = express.Router();

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Generate random numeric OTP
function generateOTP(length = 6) {
  return crypto
    .randomInt(0, Math.pow(10, length))
    .toString()
    .padStart(length, "0");
}

/**
 * @route POST /api/phone/request-otp
 * @desc Send OTP to user's phone
 */
router.post(
  "/request-otp",
  body("phone").notEmpty().withMessage("Phone number is required"),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });

      const { phone } = req.body;

      // Check if user exists
      const user = await User.findOne({ phone });
      if (!user) return res.status(404).json({ message: "User not found" });

      // Generate OTP & set expiry
      const otp = generateOTP();
      user.phoneOTP = otp;
      user.phoneOTPExpires = Date.now() + 10 * 60 * 1000; // 10 mins
      await user.save();

      // Send OTP via SMS
      await client.messages.create({
        body: `Your verification code is ${otp}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });

      res.json({ message: "OTP sent successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * @route POST /api/phone/verify-otp
 * @desc Verify OTP and mark phone as verified
 */
router.post(
  "/verify-otp",
  [
    body("phone").notEmpty().withMessage("Phone number is required"),
    body("otp").notEmpty().withMessage("OTP is required"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });

      const { phone, otp } = req.body;

      const user = await User.findOne({ phone });
      if (!user) return res.status(404).json({ message: "User not found" });

      if (!user.phoneOTP || !user.phoneOTPExpires) {
        return res.status(400).json({ message: "OTP not requested" });
      }

      if (Date.now() > user.phoneOTPExpires) {
        return res.status(400).json({ message: "OTP expired" });
      }

      if (otp !== user.phoneOTP) {
        return res.status(400).json({ message: "Invalid OTP" });
      }

      // Mark phone as verified
      user.isPhoneVerified = true;
      user.phoneOTP = undefined;
      user.phoneOTPExpires = undefined;
      await user.save();

      res.json({ message: "Phone number verified successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

module.exports = router;
