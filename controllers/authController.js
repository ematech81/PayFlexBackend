const { validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const User = require("../models/user");

// ---------- Helpers ----------
const signToken = (user) =>
  jwt.sign({ id: user._id, roles: user.roles }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

/** Create a 6-digit numeric OTP as a string */
const generateOtp = () => crypto.randomInt(100000, 999999).toString();

/** Create a nodemailer transporter (use your SMTP of choice) */
const mailer = nodemailer.createTransport({
  service: "gmail", // or configure host/port/secure for custom SMTP
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/** Send email (simple helper) */
async function sendEmail({ to, subject, html, text }) {
  await mailer.sendMail({
    from: `"${process.env.EMAIL_FROM_NAME || "PayFlex"}" <${
      process.env.EMAIL_USER
    }>`,
    to,
    subject,
    text,
    html,
  });
}

// --- Phone OTP helpers & endpoints ---
const twilio = require("twilio");
const client =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;
const OTP_EXP_MIN = 10; // 10 minutes expiry
const RESEND_COOLDOWN_SEC = 60; // min 60s between sends

/** Infer last-sent time from expiry (sentAt = expires - OTP_EXP_MIN) */
function getLastSentFromExpiry(expires) {
  if (!expires) return null;
  return new Date(new Date(expires).getTime() - OTP_EXP_MIN * 60 * 1000);
}

/** Very light E.164 normalizer for NG numbers (fallback: return as-is) */
function toE164(phone) {
  const p = (phone || "").trim();
  if (p.startsWith("+")) return p;
  if (/^0\d{10}$/.test(p)) return `+234${p.slice(1)}`; // 0xxxxxxxxxx -> +234xxxxxxxxxx
  if (/^234\d{10}$/.test(p)) return `+${p}`;
  return p;
}

/** Send SMS via Twilio (dev-safe: logs OTP if Twilio not configured) */
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

/** Mask phone for response */
function maskPhone(p) {
  if (!p) return null;
  const last4 = p.slice(-4);
  return `****${last4}`;
}

// ---------- Controllers ----------

/**
 * Register
 * - Creates user
 * - Hashes password
 * - Generates + hashes email OTP, sets 10-min expiry
 * - Sends OTP email
 * - Sends OTP phone
 * - Returns userId (NO token yet; require email verification)
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

    // Generate + hash OTP for email
    const emailOtpPlain = generateOtp();
    const emailOtpHash = await bcrypt.hash(emailOtpPlain, 10);
    const emailOtpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    const user = await User.create({
      firstName,
      lastName,
      email: email?.toLowerCase(),
      phone,
      passwordHash,
      isEmailVerified: false,
      isPhoneVerified: false,
      emailOTP: emailOtpHash, // store HASH (best practice)
      emailOTPExpires: emailOtpExpires,
    });

    // Send OTP email
    await sendEmail({
      to: user.email,
      subject: "Verify your email",
      text: `Your verification code is ${emailOtpPlain}. It expires in 10 minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;">
          <h2>Verify your email</h2>
          <p>Your verification code is:</p>
          <p style="font-size:28px;letter-spacing:4px;"><b>${emailOtpPlain}</b></p>
          <p>This code expires in 10 minutes.</p>
        </div>
      `,
    });

    // We don’t return a token yet; require email verification first
    res.status(201).json({
      message:
        "Registration successful. Check your email for the verification code.",
      userId: user._id,
      email: user.email,
    });
  } catch (e) {
    next(e);
  }
};

/**
 * Resend Email OTP
 * - Regenerates OTP (optional: throttle on client/UI)
 */
exports.resendEmailOtp = async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.isEmailVerified)
      return res.status(400).json({ message: "Email already verified" });

    const emailOtpPlain = generateOtp();
    const emailOtpHash = await bcrypt.hash(emailOtpPlain, 10);
    user.emailOTP = emailOtpHash;
    user.emailOTPExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    await sendEmail({
      to: user.email,
      subject: "Your new email verification code",
      text: `Your verification code is ${emailOtpPlain}. It expires in 10 minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;">
          <h2>New verification code</h2>
          <p>Your verification code is:</p>
          <p style="font-size:28px;letter-spacing:4px;"><b>${emailOtpPlain}</b></p>
          <p>This code expires in 10 minutes.</p>
        </div>
      `,
    });

    res.json({ message: "Verification code resent" });
  } catch (e) {
    next(e);
  }
};

/**
 * Verify Email OTP
 * - Compares provided OTP with stored HASH
 * - Checks expiry
 * - Marks isEmailVerified = true, clears fields
 * - Optionally returns a token for immediate login UX
 */
exports.verifyEmailOtp = async (req, res, next) => {
  try {
    const { userId, otp } = req.body;
    if (!userId || !otp)
      return res.status(400).json({ message: "userId and otp are required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.isEmailVerified)
      return res.status(400).json({ message: "Email already verified" });

    if (!user.emailOTP || !user.emailOTPExpires)
      return res.status(400).json({ message: "No OTP in progress" });

    if (Date.now() > new Date(user.emailOTPExpires).getTime())
      return res
        .status(400)
        .json({ message: "OTP expired, please request a new one" });

    const ok = await bcrypt.compare(String(otp), user.emailOTP);
    if (!ok) return res.status(400).json({ message: "Invalid OTP" });

    user.isEmailVerified = true;
    user.emailOTP = undefined;
    user.emailOTPExpires = undefined;
    await user.save();

    // Option A: return success only (then user can login manually)
    // return res.json({ message: "Email verified successfully" });

    // Option B (nicer UX): issue token immediately after verification
    const token = signToken(user);
    res.json({
      message: "Email verified successfully",
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        isEmailVerified: user.isEmailVerified,
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
 * Login
 * - Requires email to be verified
 * - Allows phone to be unverified (frontend will prompt to verify before transactions)
 */
exports.login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { emailOrPhone, password } = req.body;

    const query = emailOrPhone?.includes("@")
      ? { email: emailOrPhone.toLowerCase() }
      : { phone: emailOrPhone };

    const user = await User.findOne(query);
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ message: "Invalid credentials" });

    if (!user.isEmailVerified) {
      return res.status(403).json({
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email to continue.",
        userId: user._id,
        email: user.email,
      });
    }

    // Optional: track last login
    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        isEmailVerified: user.isEmailVerified,
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

// ----- Existing PIN + /me (unchanged) -----

exports.setPin = async (req, res, next) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ message: "PIN must be 4–6 digits" });
    }
    const pinHash = await bcrypt.hash(String(pin), 12);
    req.user.pinHash = pinHash;
    await req.user.save();
    res.json({ message: "Transaction PIN set successfully" });
  } catch (e) {
    next(e);
  }
};

// POST /api/auth/phone/send-otp
exports.sendPhoneOtp = async (req, res, next) => {
  try {
    const user = req.user; // protect middleware sets this
    if (!user.phone)
      return res.status(400).json({ message: "No phone number on profile" });
    if (user.isPhoneVerified)
      return res.status(400).json({ message: "Phone already verified" });

    // Throttle: 60s between sends
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

    const otp = generateOtp();
    const hash = await bcrypt.hash(otp, 10);
    user.phoneOTP = hash; // store HASH (best practice)
    user.phoneOTPExpires = new Date(Date.now() + OTP_EXP_MIN * 60 * 1000);
    await user.save();

    await sendSmsOtp(user.phone, otp);

    res.json({
      message: "OTP sent successfully",
      to: maskPhone(user.phone),
      expiresInMinutes: OTP_EXP_MIN,
    });
  } catch (e) {
    next(e);
  }
};

// POST /api/auth/phone/resend-otp (same logic as send-otp, kept for clarity)
exports.resendPhoneOtp = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.phone)
      return res.status(400).json({ message: "No phone number on profile" });
    if (user.isPhoneVerified)
      return res.status(400).json({ message: "Phone already verified" });

    // Throttle: 60s between sends
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

    const otp = generateOtp();
    const hash = await bcrypt.hash(otp, 10);
    user.phoneOTP = hash;
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

// POST /api/auth/phone/verify-otp  { otp: "123456" }
exports.verifyPhoneOtp = async (req, res, next) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ message: "OTP is required" });

    const user = req.user;
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
    await user.save();

    res.json({ message: "Phone verified successfully" });
  } catch (e) {
    next(e);
  }
};

exports.me = async (req, res, next) => {
  try {
    const u = req.user;
    res.json({
      id: u._id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone,
      isEmailVerified: u.isEmailVerified,
      isPhoneVerified: u.isPhoneVerified,
      kyc: u.kyc,
      walletBalance: u.walletBalance,
      roles: u.roles,
    });
  } catch (e) {
    next(e);
  }
};
