const { validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/user");

// ---------- Helpers ----------
const signToken = (user) =>
  jwt.sign({ id: user._id, roles: user.roles }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

/** Create a 6-digit numeric OTP as a string */
const generateOtp = () => crypto.randomInt(100000, 999999).toString();

/** --- SMS (Twilio) setup; logs OTP in dev if not configured --- */
const twilio = require("twilio");
const client =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

const OTP_EXP_MIN = 10; // 10 minutes expiry
const RESEND_COOLDOWN_SEC = 60; // min 60s between sends

/** Light E.164 formatter for NG numbers */
function toE164(phone) {
  const p = (phone || "").trim();
  if (p.startsWith("+")) return p;
  if (/^0\d{10}$/.test(p)) return `+234${p.slice(1)}`;
  if (/^234\d{10}$/.test(p)) return `+${p}`;
  return p; // fallback (don’t block)
}

/** Send SMS via Twilio (or log in dev) */
async function sendSmsOtp(phone, otp) {
  const to = toE164(phone);
  if (!client || !process.env.TWILIO_PHONE_NUMBER) {
    console.log("⚠️ Twilio not configured. OTP for", to, "=", otp);
    return;
  }
  await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body: `Your PayFlex verification code is ${otp}. It expires in ${OTP_EXP_MIN} minutes.`,
  });
}

/** Mask phone for responses */
function maskPhone(p) {
  if (!p) return null;
  const last4 = p.slice(-4);
  return `****${last4}`;
}

/** Infer last-sent time from expiry (sentAt = expires - OTP_EXP_MIN) */
function getLastSentFromExpiry(expires) {
  if (!expires) return null;
  return new Date(new Date(expires).getTime() - OTP_EXP_MIN * 60 * 1000);
}

// ---------- Controllers ----------

/**
 * POST /api/auth/register
 * Body: { firstName, lastName, email, phone, password }
 * Flow:
 *  - Creates user (email stored as-is; no email verification)
 *  - Generates + stores HASHED phone OTP (10min expiry)
 *  - Sends OTP SMS
 *  - Returns { userId, phoneMasked, expiresInMinutes } (NO token yet)
 */
exports.register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { firstName, lastName, email, phone, password } = req.body;

    const exists = await User.findOne({
      $or: [{ email: email?.toLowerCase() }, { phone }],
    });
    if (exists)
      return res.status(409).json({ message: "Email or phone already in use" });

    const passwordHash = await bcrypt.hash(password, 12);

    // Create user first
    const user = await User.create({
      firstName,
      lastName,
      email: email?.toLowerCase(),
      phone,
      passwordHash,
      isEmailVerified: false, // optional; kept for model compatibility
      isPhoneVerified: false,
    });

    // Generate + hash phone OTP
    const otp = generateOtp();
    user.phoneOTP = await bcrypt.hash(otp, 10);
    user.phoneOTPExpires = new Date(Date.now() + OTP_EXP_MIN * 60 * 1000);
    await user.save();

    // Send SMS
    await sendSmsOtp(user.phone, otp);

    res.status(201).json({
      message: "Registration successful. We sent a code to your phone.",
      userId: user._id,
      phone: maskPhone(user.phone),
      expiresInMinutes: OTP_EXP_MIN,
    });
  } catch (e) {
    next(e);
  }
};

/**
 * POST /api/auth/phone/resend
 * Body: { userId }
 * Public (used right after registration screen)
 */
exports.resendPhoneOtpPublic = async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.phone)
      return res.status(400).json({ message: "No phone on file" });
    if (user.isPhoneVerified)
      return res.status(400).json({ message: "Phone already verified" });

    // Throttle resend
    if (user.phoneOTPExpires) {
      const lastSent = getLastSentFromExpiry(user.phoneOTPExpires);
      if (
        lastSent &&
        Date.now() - lastSent.getTime() < RESEND_COOLDOWN_SEC * 1000
      ) {
        const wait = Math.ceil(
          (RESEND_COOLDOWN_SEC * 1000 - (Date.now() - lastSent.getTime())) /
            1000
        );
        return res.status(429).json({
          message: `Please wait ${wait}s before requesting another code`,
        });
      }
    }

    // New OTP
    const otp = generateOtp();
    user.phoneOTP = await bcrypt.hash(otp, 10);
    user.phoneOTPExpires = new Date(Date.now() + OTP_EXP_MIN * 60 * 1000);
    await user.save();

    await sendSmsOtp(user.phone, otp);

    res.json({
      message: "OTP resent successfully",
      to: maskPhone(user.phone),
      expiresInMinutes: OTP_EXP_MIN,
    });
  } catch (e) {
    next(e);
  }
};

/**
 * POST /api/auth/phone/verify
 * Body: { userId, otp }
 * Public (verifies right after registration)
 * On success: marks phone verified, clears OTP, returns JWT + user
 */
exports.verifyPhoneOtpPublic = async (req, res, next) => {
  try {
    const { userId, otp } = req.body;
    if (!userId || !otp)
      return res.status(400).json({ message: "userId and otp are required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.isPhoneVerified)
      return res.status(400).json({ message: "Phone already verified" });

    if (!user.phoneOTP || !user.phoneOTPExpires)
      return res.status(400).json({ message: "No OTP in progress" });

    if (Date.now() > new Date(user.phoneOTPExpires).getTime())
      return res
        .status(400)
        .json({ message: "OTP expired, please request a new one" });

    const ok = await bcrypt.compare(String(otp), user.phoneOTP);
    if (!ok) return res.status(400).json({ message: "Invalid OTP" });

    user.isPhoneVerified = true;
    user.phoneOTP = undefined;
    user.phoneOTPExpires = undefined;
    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user);
    res.json({
      message: "Phone verified successfully",
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified,
        kyc: user.kyc,
        walletBalance: user.walletBalance,
        roles: user.roles,
      },
    });
  } catch (e) {
    next(e);
  }
};

/**
 * POST /api/auth/login
 * Body: { emailOrPhone, password }
 * Blocks login if phone is NOT verified (frontend can push to OTP screen)
 */

exports.login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log("Validation errors:", errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const { phone, pin } = req.body;
    console.log("Login attempt:", { phone, pin });

    const user = await User.findOne({ phone });
    if (!user) {
      console.log("User not found for phone:", phone);
      return res.status(400).json({ message: "Invalid credentials" });
    }

    if (!user.isPhoneVerified) {
      console.log("Phone not verified for user:", user._id);
      return res.status(403).json({
        code: "PHONE_NOT_VERIFIED",
        message: "Please verify your phone number to continue.",
        userId: user._id,
        phone: user.phone,
      });
    }

    if (!user.pinHash) {
      console.log("PIN not set for user:", user._id);
      return res
        .status(400)
        .json({ message: "PIN not set. Please set a PIN." });
    }

    const ok = await bcrypt.compare(pin, user.pinHash);
    console.log("PIN comparison result:", ok);
    if (!ok) {
      return res.status(400).json({ message: "Invalid PIN" });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user);
    console.log("Generated token:", token);
    res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified,
        kyc: user.kyc,
        walletBalance: user.walletBalance,
        roles: user.roles,
      },
    });
  } catch (e) {
    console.error("Login error:", e);
    next(e);
  }
};

// login with PIN only
exports.loginPin = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log("Validation errors:", errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const { pin } = req.body;
    const user = req.user; // From protect middleware
    console.log("PIN login attempt for user:", user._id);

    if (!user.isPhoneVerified) {
      console.log("Phone not verified for user:", user._id);
      return res.status(403).json({
        code: "PHONE_NOT_VERIFIED",
        message: "Please verify your phone number to continue.",
        userId: user._id,
        phone: user.phone,
      });
    }

    if (!user.pinHash) {
      console.log("PIN not set for user:", user._id);
      return res
        .status(400)
        .json({ message: "PIN not set. Please set a PIN." });
    }

    const ok = await bcrypt.compare(pin, user.pinHash);
    console.log("PIN comparison result:", ok);
    if (!ok) {
      return res.status(400).json({ message: "Invalid PIN" });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user);
    console.log("Generated token:", token);
    res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified,
        kyc: user.kyc,
        walletBalance: user.walletBalance,
        roles: user.roles,
      },
    });
  } catch (e) {
    console.error("PIN login error:", e);
    next(e);
  }
};

/**
 * POST /api/pin/set  (moved to /routes/pinRoutes.js in your setup)
 * Body: { pin }
 * Auth required (protect)
 */

exports.setPin = async (req, res, next) => {
  try {
    const { userId, pin } = req.body;
    if (!userId || !pin) {
      return res.status(400).json({ message: "userId and pin are required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.isPhoneVerified) {
      return res.status(400).json({ message: "Phone not verified" });
    }

    if (user.pinHash) {
      return res.status(400).json({ message: "PIN already set" });
    }

    user.pinHash = await bcrypt.hash(pin, 12);
    await user.save();

    res.json({ message: "PIN set successfully" });
  } catch (e) {
    next(e);
  }
};

// transaction PIN verification middleware

exports.setTransactionPin = async (req, res) => {
  const { pin } = req.body;
  const userId = req.user.id;
  if (!pin || !/^\d{4}$/.test(pin)) {
    return res
      .status(400)
      .json({ message: "Transaction PIN must be 4 digits" });
  }
  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }
  user.transactionPinHash = pin; // Hashed by pre-save hook
  await user.save();
  res
    .status(200)
    .json({ success: true, message: "Transaction PIN set successfully" });
};

exports.resetTransactionPin = async (req, res) => {
  try {
    const { pin, otp } = req.body; // Validated: pin (4 digits), otp (6 digits)
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (
      !user.phoneOTP ||
      user.phoneOTP !== otp ||
      user.phoneOTPExpires < Date.now()
    ) {
      return res.status(403).json({ message: "Invalid or expired OTP" });
    }
    user.transactionPinHash = pin; // Hashed by pre-save hook
    user.phoneOTP = null;
    user.phoneOTPExpires = null;
    await user.save();
    res
      .status(200)
      .json({ success: true, message: "Transaction PIN reset successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.resetLoginPin = async (req, res) => {
  try {
    const { pin, otp } = req.body; // Validated: pin (6 digits), otp (6 digits)
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (
      !user.phoneOTP ||
      user.phoneOTP !== otp ||
      user.phoneOTPExpires < Date.now()
    ) {
      return res.status(403).json({ message: "Invalid or expired OTP" });
    }
    user.pinHash = pin; // Hashed by pre-save hook
    user.phoneOTP = null;
    user.phoneOTPExpires = null;
    await user.save();
    res
      .status(200)
      .json({ success: true, message: "Login PIN reset successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

/**
 * GET /api/auth/me
 * Auth required (protect)
 */

exports.me = async (req, res, next) => {
  try {
    const u = req.user;
    res.json({
      id: u._id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone,
      isPhoneVerified: u.isPhoneVerified,
      kyc: u.kyc,
      walletBalance: u.walletBalance,
      roles: u.roles,
      transactionPinSet: !!u.transactionPinHash, // Add flag to indicate if transaction PIN is set
    });
  } catch (e) {
    next(e);
  }
};
