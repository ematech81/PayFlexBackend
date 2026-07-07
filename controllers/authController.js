const { validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const axios = require("axios");
const { v2: cloudinary } = require("cloudinary");
const User = require("../models/user");
const PendingRegistration = require("../models/PendingRegistration");
const { generateAlphanumericOTP } = require("../service/bulkSmsService");
const { sendEmail }               = require("../util/sendEmail");

// Configure Cloudinary (reads from env at call time)
cloudinary.config({
  cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
  api_key:     process.env.CLOUDINARY_API_KEY,
  api_secret:  process.env.CLOUDINARY_API_SECRET,
});




// ---------- Configuration ----------
const OTP_EXP_MIN = 10; // OTP expires in 10 minutes
const RESEND_COOLDOWN_SEC = 60; // Minimum 60 seconds between OTP sends
const BCRYPT_ROUNDS = 12; // Password hashing rounds
const JWT_EXPIRES_IN = "7d"; // JWT token expiration

// ---------- Helper Functions ----------

/**
 * Signs a JWT token for authenticated user
 * @param {Object} user - User document
 * @returns {String} JWT token
 */
const signToken = (user) =>
  jwt.sign(
    { id: user._id, roles: user.roles },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  ); 

/**
 * Generates a 6-character alphanumeric access key (always mixes letters
 * and digits — required for delivery via BulkSMS Nigeria)
 * @returns {String} 6-character access key
 */
const generateOtp = () => generateAlphanumericOTP();

/**
 * Converts Nigerian phone numbers to E.164 format
 * @param {String} phone - Phone number
 * @returns {String} E.164 formatted phone (+234xxxxxxxxxx)
 */
function toE164(phone) {
  const p = (phone || "").trim();
  if (p.startsWith("+")) return p;
  if (/^0\d{10}$/.test(p)) return `+234${p.slice(1)}`;
  if (/^234\d{10}$/.test(p)) return `+${p}`;
  return p; // fallback
}

/**
 * Masks phone number for secure display
 * @param {String} phone - Phone number
 * @returns {String} Masked phone (****1234)
 */
function maskPhone(phone) {
  if (!phone) return null;
  const last4 = phone.slice(-3);
  return `****${last4}`;
}

/**
 * Calculates last sent time from OTP expiry
 * @param {Date} expires - OTP expiration date
 * @returns {Date|null} Last sent timestamp
 */
function getLastSentFromExpiry(expires) {
  if (!expires) return null;
  return new Date(new Date(expires).getTime() - OTP_EXP_MIN * 60 * 1000);
}

// ---------- SMS Service ----------
const { sendOtp } = require("../service/smsService");

/**
 * Sends OTP via SMS + email.
 *
 * When BULKSMS_API_TOKEN is set (i.e. real SMS delivery), both jobs are
 * fired-and-forgotten so the HTTP response is not held up by delivery latency.
 * When the token is absent (local dev), we await SMS so `devOtp` can be
 * returned to the client for easy testing.
 */
async function dispatchOtp(phone, email, otp) {
  const hasToken = !!process.env.BULKSMS_API_TOKEN;

  const smsJob   = () => sendOtp(phone, otp, OTP_EXP_MIN).catch(e => console.error("[otp] SMS error:", e.message));
  const emailJob = () => email
    ? sendEmail(email, "PayFlex — Your Verification Code",
        `Your PayFlex access key is: ${otp}\n\nIt expires in ${OTP_EXP_MIN} minutes. Do not share it with anyone.`
      ).catch(e => console.error("[otp] Email error:", e.message))
    : Promise.resolve();

  if (!hasToken) {
    // Dev: await so we can return devOtp to the client
    const smsResult = await smsJob();
    emailJob();
    return { devOtp: smsResult?.devOtp };
  }

  // Real delivery: fire-and-forget — respond instantly, deliver in background
  smsJob();
  emailJob();
  return {};
}

// ---------- Main Controller ----------

/**
 * POST /api/auth/register
 * 
 * Registers a new user and sends phone verification OTP
 * 
 * Request Body:
 * @param {String} firstName - User's first name
 * @param {String} lastName - User's last name  
 * @param {String} email - User's email address
 * @param {String} phone - User's phone number (Nigerian format)
 * @param {String} password - User's password (min 6 characters)
 * 
 * Response:
 * @returns {201} { message, userId, phone, expiresInMinutes }
 * @returns {400} { errors: [...] } - Validation errors
 * @returns {409} { message } - Email/phone already exists
 * @returns {500} { message } - Server error
 * 
 * Flow:
 * 1. Validates input data
 * 2. Checks for existing user (email or phone)
 * 3. Creates new user with hashed password
 * 4. Generates and stores hashed OTP
 * 5. Sends OTP via SMS
 * 6. Returns masked phone and userId (NO JWT token yet - user must verify phone first)
 */
exports.register = async (req, res, next) => {
  try {
    // Step 1: Validate request body
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { firstName, lastName, email, phone, password } = req.body;
    const normalizedEmail = email?.toLowerCase().trim();
    const normalizedPhone = toE164(phone);

    // Step 2: Check if email/phone already belong to a verified account
    const existingUser = await User.findOne({
      $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
    });
    if (existingUser) {
      const field = existingUser.email === normalizedEmail ? "Email" : "Phone number";
      return res.status(409).json({
        success: false,
        message: `${field} already registered. Please login instead.`,
      });
    }

    // Step 3: Hash password and generate OTP
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const otp      = generateOtp();
    const otpHash  = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXP_MIN * 60 * 1000);

    // Step 4: Upsert PendingRegistration — no real User created yet.
    // If the same phone/email tries again (e.g. OTP not received), we refresh
    // the OTP so they can re-attempt without being permanently blocked.
    await PendingRegistration.findOneAndUpdate(
      { $or: [{ email: normalizedEmail }, { phone: normalizedPhone }] },
      {
        firstName: firstName.trim(),
        lastName:  lastName.trim(),
        email:     normalizedEmail,
        phone:     normalizedPhone,
        passwordHash,
        otpHash,
        otpExpires: expiresAt,
        createdAt:  new Date(), // reset TTL on re-attempt
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Step 5: Dispatch OTP (fire-and-forget in prod to avoid HTTP timeout)
    const { devOtp } = await dispatchOtp(normalizedPhone, normalizedEmail, otp);

    return res.status(201).json({
      success: true,
      message: "Registration started. Your access key has been sent via SMS and email.",
      phone:            maskPhone(normalizedPhone),
      email:            normalizedEmail ? `${normalizedEmail.slice(0, 3)}***${normalizedEmail.slice(normalizedEmail.indexOf('@'))}` : undefined,
      expiresInMinutes: OTP_EXP_MIN,
      ...(devOtp && { devOtp }),
    });

  } catch (error) {
    console.error("❌ Registration error:", error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "Email or phone already in use." });
    }
    next(error);
  }
};







/**
 * POST /api/auth/phone/verify-otp
 * 
 * Verifies phone number using OTP sent during registration
 * 
 * Request Body:
 * @param {String} phone - User's phone number (any format: 0801..., +2348...)
 * @param {String} otp - 6-digit OTP code
 * 
 * Response:
 * @returns {200} { success, message, token, user }
 * @returns {400} { success, message } - Invalid input or OTP
 * @returns {404} { success, message } - User not found
 * @returns {500} { success, message } - Server error
 * 
 * Flow:
 * 1. Validates input
 * 2. Normalizes phone to E.164 format
 * 3. Finds user by phone
 * 4. Validates OTP exists and not expired
 * 5. Compares OTP hash
 * 6. Marks phone as verified
 * 7. Clears OTP fields
 * 8. Returns JWT token and user data
 */
exports.verifyPhoneOtpPublic = async (req, res, next) => {
  try {
    const { phone, otp, deviceId } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: "Phone number and OTP are required" });
    }
    if (!/^[A-Z0-9]{6}$/i.test(otp.trim())) {
      return res.status(400).json({ success: false, message: "Access key must be exactly 6 characters" });
    }

    const normalizedPhone = toE164(phone);
    console.log(`📱 Verifying phone OTP for: ${maskPhone(normalizedPhone)}`);

    // Look up the pending registration — real User does NOT exist yet
    const pending = await PendingRegistration.findOne({ phone: normalizedPhone })
      .select('+passwordHash +otpHash');

    if (!pending) {
      // Could be a re-use after successful verification (user already exists)
      const alreadyVerified = await User.exists({ phone: normalizedPhone, isPhoneVerified: true });
      if (alreadyVerified) {
        return res.status(400).json({ success: false, message: "Phone already verified. Please login.", alreadyVerified: true });
      }
      return res.status(404).json({ success: false, message: "No pending registration found. Please register first." });
    }

    // Check expiry
    if (Date.now() > new Date(pending.otpExpires).getTime()) {
      return res.status(400).json({
        success: false,
        message: "Verification code expired. Please request a new one.",
        isExpired: true,
        shouldResend: true,
      });
    }

    // Verify OTP
    const isValidOTP = await bcrypt.compare(String(otp.trim()).toUpperCase(), pending.otpHash);
    if (!isValidOTP) {
      console.log(`❌ Invalid OTP attempt for ${maskPhone(normalizedPhone)}`);
      return res.status(400).json({ success: false, message: "Invalid verification code. Please try again." });
    }

    // OTP is correct — now create the real User
    const devices = deviceId ? [deviceId.trim().toLowerCase()] : [];
    const user = await User.create({
      firstName:       pending.firstName,
      lastName:        pending.lastName,
      email:           pending.email,
      phone:           pending.phone,
      passwordHash:    pending.passwordHash,
      isEmailVerified: false,
      isPhoneVerified: true,
      devices,
      walletBalance:   0,
      kyc:             "pending",
      roles:           ["user"],
      isActive:        true,
      lastLogin:       new Date(),
    });

    // Clean up pending record
    await PendingRegistration.findByIdAndDelete(pending._id).catch(() => {});

    console.log(`✅ Phone verified & user created for ${maskPhone(normalizedPhone)}`);

    const token = signToken(user);

    return res.status(200).json({
      success: true,
      message: "Phone verified successfully",
      token,
      user: {
        id:              user._id,
        firstName:       user.firstName,
        lastName:        user.lastName,
        email:           user.email,
        phone:           maskPhone(user.phone),
        isPhoneVerified: user.isPhoneVerified,
        kyc:             user.kyc,
        walletBalance:   user.walletBalance,
        roles:           user.roles,
        requirePinOnOpen: user.requirePinOnOpen,
      },
    });

  } catch (error) {
    console.error("❌ Phone OTP verification error:", error);
    if (error.name === "CastError") {
      return res.status(400).json({ success: false, message: "Invalid phone number format" });
    }
    next(error);
  }
};




/**
 * POST /api/auth/phone/resend
 * Body: { userId }
 * Public (used right after registration screen)
 */
exports.resendPhoneOtpPublic = async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "phone is required" });

    const normalizedPhone = toE164(phone);

    const pending = await PendingRegistration.findOne({ phone: normalizedPhone })
      .select('+otpHash');

    if (!pending) {
      const alreadyVerified = await User.exists({ phone: normalizedPhone, isPhoneVerified: true });
      if (alreadyVerified) {
        return res.status(400).json({ success: false, message: "Phone already verified. Please login." });
      }
      return res.status(404).json({ success: false, message: "No pending registration. Please register first." });
    }

    // Throttle resend
    if (pending.otpExpires) {
      const lastSent = getLastSentFromExpiry(pending.otpExpires);
      if (lastSent && Date.now() - lastSent.getTime() < RESEND_COOLDOWN_SEC * 1000) {
        const wait = Math.ceil((RESEND_COOLDOWN_SEC * 1000 - (Date.now() - lastSent.getTime())) / 1000);
        return res.status(429).json({ success: false, message: `Please wait ${wait}s before requesting another code` });
      }
    }

    // New OTP
    const otp = generateOtp();
    pending.otpHash    = await bcrypt.hash(otp, 10);
    pending.otpExpires = new Date(Date.now() + OTP_EXP_MIN * 60 * 1000);
    pending.createdAt  = new Date(); // reset TTL
    await pending.save();

    const { devOtp } = await dispatchOtp(normalizedPhone, pending.email, otp);

    return res.json({
      success: true,
      message: "Your access key has been sent via SMS and email.",
      to: maskPhone(normalizedPhone),
      expiresInMinutes: OTP_EXP_MIN,
      ...(devOtp && { devOtp }),
    });
  } catch (e) {
    next(e);
  }
};



/**
 * POST /api/auth/login
 * 
 * Authenticates user with phone and PIN
 * Detects new devices and triggers OTP verification
 * 
 * Request Body:
 * @param {string} phone - User's phone number (any format)
 * @param {string} pin - 6-digit PIN
 * @param {string} deviceId - Unique device identifier
 * 
 * Response:
 * @returns {200} Known device - { success, token, user }
 * @returns {200} New device - { success, isNewDevice, message }
 * @returns {400/401/403/404} Error responses
 */
exports.login = async (req, res, next) => {
  try {
    const { phone, pin, deviceId } = req.body;

    // Step 1: Input validation
    if (!phone || !pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: "Phone number and a valid 6-digit PIN are required",
      });
    }

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: "Device ID is required",
      });
    }

    // Step 2: Normalize phone to E.164 format
    const normalizedPhone = toE164(phone);

    console.log(`🔐 Login attempt for ${maskPhone(normalizedPhone)}`);

    // Step 3: Find user with PIN and devices
    const user = await User.findOne({ phone: normalizedPhone })
      .select("+pinHash +devices +phoneOTP +phoneOTPExpires");

    if (!user) {
      console.log(`❌ User not found: ${maskPhone(normalizedPhone)}`);
      return res.status(404).json({
        success: false,
        message: "Invalid phone number or PIN",
      });
    }

    // Step 4: Check if PIN exists
    if (!user.pinHash) {
      return res.status(400).json({
        success: false,
        message: "Please set your PIN first",
        requiresPinSetup: true,
      });
    }

    // Step 5: Verify PIN
    const isMatch = await bcrypt.compare(String(pin), user.pinHash);
    if (!isMatch) {
      console.log(`❌ Invalid PIN for ${maskPhone(normalizedPhone)}`);
      return res.status(401).json({
        success: false,
        message: "Invalid PIN",
      });
    }

    // Step 6: Check if phone is verified
    if (!user.isPhoneVerified) {
      return res.status(403).json({
        success: false,
        message: "Phone number not verified",
        code: "PHONE_NOT_VERIFIED",
        requiresPhoneVerification: true,
      });
    }

    // Step 7: Device verification check
    const normalizedDeviceId = deviceId.trim().toLowerCase();
    
    // Normalize existing devices for comparison
    const userDevices = (user.devices || []).map(d => d.toLowerCase());
    const isNewDevice = !userDevices.includes(normalizedDeviceId);

    if (isNewDevice) {
      console.log(`🆕 New device detected for ${maskPhone(normalizedPhone)}`);

      // Generate OTP for device verification
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);
      const expiresAt = new Date(Date.now() + OTP_EXP_MIN * 60 * 1000);

      user.phoneOTP = otpHash;
      user.phoneOTPExpires = expiresAt;
      await user.save();

      const { devOtp } = await dispatchOtp(user.phone, user.email, otp);

      return res.status(200).json({
        success: true,
        isNewDevice: true,
        message: "New device detected. Your access key has been sent via SMS and email.",
        phone: maskPhone(user.phone),
        expiresInMinutes: OTP_EXP_MIN,
        ...(devOtp && { devOtp }),
      });
    }

    // Step 8: Known device → Complete login
    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user);

    console.log(`✅ Login successful for ${maskPhone(normalizedPhone)}`);

    return res.status(200).json({
      success: true,
      isNewDevice: false,
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: maskPhone(user.phone),
        isPhoneVerified: user.isPhoneVerified,
        kyc: user.kyc,
        walletBalance: user.walletBalance,
        roles: user.roles,
        requirePinOnOpen: user.requirePinOnOpen ?? true,
      },
    });

  } catch (error) {
    console.error("❌ Login error:", error);
    next(error);
  }
};


//  VERIFY DEVICE OTP 

/**
 * POST /api/auth/verify-device-otp
 * 
 * Verifies OTP sent to new device and completes login
 * Adds device to user's trusted devices list
 * 
 * Request Body:
 * @param {string} phone - User's phone number
 * @param {string} otp - 6-digit OTP code
 * @param {string} deviceId - Device identifier to be trusted
 * 
 * Response:
 * @returns {200} { success, token, user }
 * @returns {400/404} Error responses
 */
exports.verifyDeviceOtp = async (req, res, next) => {
  try {
    const { phone, otp, deviceId } = req.body;

    // Step 1: Validate input
    if (!phone || !otp || !deviceId) {
      return res.status(400).json({
        success: false,
        message: "Phone number, OTP, and device ID are required",
      });
    }

    if (!/^[A-Z0-9]{6}$/i.test(otp.trim())) {
      return res.status(400).json({
        success: false,
        message: "Access key must be exactly 6 characters",
      });
    }

    // Step 2: Normalize phone
    const normalizedPhone = toE164(phone);

    console.log(`📱 Verifying device OTP for ${maskPhone(normalizedPhone)}`);

    // Step 3: Find user with OTP fields and devices
    const user = await User.findOne({ phone: normalizedPhone })
      .select("+phoneOTP +phoneOTPExpires +devices");

    if (!user) {
      console.log(`❌ User not found: ${maskPhone(normalizedPhone)}`);
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Reviewer bypass: REVIEWER_ACCESS_KEY skips OTP entirely
    const reviewerKey = process.env.REVIEWER_ACCESS_KEY;
    if (reviewerKey && otp.trim().toUpperCase() === reviewerKey.toUpperCase()) {
      const normalizedDeviceId = deviceId.trim().toLowerCase();
      if (!user.devices) user.devices = [];
      if (!user.devices.map(d => d.toLowerCase()).includes(normalizedDeviceId)) {
        user.devices.push(normalizedDeviceId);
      }
      user.lastLogin = new Date();
      await user.save();
      const token = signToken(user);
      return res.status(200).json({
        success: true,
        message: "Device verified successfully",
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: maskPhone(user.phone),
          isPhoneVerified: user.isPhoneVerified,
          kyc: user.kyc,
          walletBalance: user.walletBalance,
          roles: user.roles,
          requirePinOnOpen: user.requirePinOnOpen ?? true,
        },
      });
    }

    // Step 4: Check if OTP exists
    if (!user.phoneOTP || !user.phoneOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "No verification code found. Please login again.",
        shouldRetryLogin: true,
      });
    }

    // Step 5: Check if OTP is expired
    const now = Date.now();
    const expiryTime = new Date(user.phoneOTPExpires).getTime();

    if (now > expiryTime) {
      const expiredMinutes = Math.floor((now - expiryTime) / 60000);
      console.log(`⏰ Device OTP expired ${expiredMinutes} minutes ago`);
      
      return res.status(400).json({
        success: false,
        message: "Verification code expired. Please login again.",
        isExpired: true,
        shouldRetryLogin: true,
      });
    }

    // Step 6: Verify OTP
    const isValidOTP = await bcrypt.compare(String(otp.trim()).toUpperCase(), user.phoneOTP);

    if (!isValidOTP) {
      console.log(`❌ Invalid device OTP for ${maskPhone(normalizedPhone)}`);
      return res.status(400).json({
        success: false,
        message: "Invalid verification code",
      });
    }

    // Step 7: Add device to trusted devices list
    const normalizedDeviceId = deviceId.trim().toLowerCase();
    
    if (!user.devices) {
      user.devices = [];
    }

    // Only add if not already in list (case-insensitive check)
    const deviceExists = user.devices
      .map(d => d.toLowerCase())
      .includes(normalizedDeviceId);

    if (!deviceExists) {
      user.devices.push(normalizedDeviceId);
      console.log(`✅ Device added to trusted list for ${maskPhone(normalizedPhone)}`);
    }

    // Step 8: Clear OTP and update login time
    user.phoneOTP = undefined;
    user.phoneOTPExpires = undefined;
    user.lastLogin = new Date();
    
    await user.save();

    // Step 9: Generate JWT token
    const token = signToken(user);

    console.log(`✅ Device verified successfully for ${maskPhone(normalizedPhone)}`);

    return res.status(200).json({
      success: true,
      message: "Device verified successfully",
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: maskPhone(user.phone),
        isPhoneVerified: user.isPhoneVerified,
        kyc: user.kyc,
        walletBalance: user.walletBalance,
        roles: user.roles,
        requirePinOnOpen: user.requirePinOnOpen ?? true,
      },
    });

  } catch (error) {
    console.error("❌ Device verification error:", error);
    next(error);
  }
};





// RESEND DEVICE OTP CONTROLLER
/**
 * POST /api/auth/resend-device-otp
 * 
 * Resends OTP for device verification
 * Includes rate limiting (60 seconds cooldown)
 * 
 * Request Body:
 * @param {string} phone - User's phone number
 * 
 * Response:
 * @returns {200} { success, message, expiresInMinutes }
 * @returns {400/404/429} Error responses
 */
exports.resendDeviceOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;

    // Step 1: Validate input
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    // Step 2: Normalize phone
    const normalizedPhone = toE164(phone);

    console.log(`📤 Resend device OTP request for ${maskPhone(normalizedPhone)}`);

    // Step 3: Find user
    const user = await User.findOne({ phone: normalizedPhone })
      .select("+phoneOTP +phoneOTPExpires");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Step 4: Rate limiting - Check cooldown (60 seconds)
    if (user.phoneOTPExpires) {
      const lastSentTime = new Date(user.phoneOTPExpires).getTime() - (OTP_EXP_MIN * 60 * 1000);
      const timeSinceLastSend = Date.now() - lastSentTime;
      const cooldownMs = 60 * 1000; // 60 seconds

      if (timeSinceLastSend < cooldownMs) {
        const waitSeconds = Math.ceil((cooldownMs - timeSinceLastSend) / 1000);
        console.log(`⏰ Rate limit: ${waitSeconds}s remaining`);
        
        return res.status(429).json({
          success: false,
          message: `Please wait ${waitSeconds} seconds before requesting a new code`,
          waitSeconds,
        });
      }
    }

    // Step 5: Generate and send new OTP
    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXP_MIN * 60 * 1000);

    user.phoneOTP = otpHash;
    user.phoneOTPExpires = expiresAt;
    await user.save();

    const { devOtp } = await dispatchOtp(user.phone, user.email, otp);

    console.log(`✅ Device OTP resent to ${maskPhone(normalizedPhone)}`);

    return res.status(200).json({
      success: true,
      message: "Your access key has been sent via SMS and email.",
      expiresInMinutes: OTP_EXP_MIN,
      ...(devOtp && { devOtp }),
    });

  } catch (error) {
    console.error("❌ Resend device OTP error:", error);
    next(error);
  }
};




//set login pin after phone verification
exports.setPin = async (req, res, next) => {
  try {
    const { pin } = req.body;
    const userId = req.user?.id || req.user?._id;
    console.log("Setting login PIN for userId:", userId);

    if (!pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: "A valid 6-digit PIN is required",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      console.log("User not found for userId:", userId);
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // ✅ Check phone verification
    if (!user.isPhoneVerified) {
      console.log("Phone not verified for userId:", userId);
      return res.status(400).json({
        success: false,
        message: "Phone not verified",
      });
    }

    // ✅ Prevent resetting PIN if already set
    if (user.pinHash) {
      console.log("PIN already set for userId:", userId);
      return res.status(400).json({
        success: false,
        message: "PIN already set",
      });
    }

    // ✅ Save PIN (hash handled by pre-save hook)
    user.pinHash = String(pin);
    await user.save();

    console.log(
      "Login PIN set successfully for phone:",
      user.phone,
      "pinHash:",
      user.pinHash
    );

    // ✅ Success response
    res.status(200).json({
      success: true,
      message: "PIN set successfully",
      userId: user._id,
      phone: user.phone,
    });
  } catch (error) {
    console.error("Set PIN error:", error.message);
    res.status(500).json({
      success: false,
      message: "Server error while setting PIN",
    });
    next(error);
  }
};




// verify login pin
exports.verifyLoginPin = async (req, res) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin || !/^\d{6}$/.test(pin)) {
      return res
        .status(400)
        .json({ message: "Phone number and 6-digit PIN are required" });
    }

    const user = await User.findOne({ phone });
    if (!user || !user.pinHash) {
      console.log("User or pinHash not found for phone:", phone);
      return res
        .status(403)
        .json({ message: "Invalid phone number or PIN not set" });
    }

    const isMatch = await bcrypt.compare(String(pin), user.pinHash);
    if (!isMatch) {
      return res.status(403).json({ message: "Invalid Login PIN" });
    }

    res.status(200).json({ success: true, message: "Login PIN verified" });
  } catch (error) {
    console.error("Verify login PIN error:", error.message);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};




/**
 * Change Login PIN
 * @route POST /api/auth/change-login-pin
 * @access Private
 */
exports.changeLoginPin = async (req, res) => {
  try {
    const { currentPin, newPin } = req.body;
    const userId = req.user.id || req.user._id;

    console.log('=== CHANGE LOGIN PIN REQUEST ===');
    console.log('User ID:', userId);
    console.log('================================');

    // Validate input
    if (!currentPin || !/^\d{6}$/.test(currentPin)) {
      return res.status(400).json({
        success: false,
        message: 'Current PIN must be a valid 6-digit number',
      });
    }

    if (!newPin || !/^\d{6}$/.test(newPin)) {
      return res.status(400).json({
        success: false,
        message: 'New PIN must be a valid 6-digit number',
      });
    }

    // Check if new PIN is same as current
    if (currentPin === newPin) {
      return res.status(400).json({
        success: false,
        message: 'New PIN must be different from current PIN',
      });
    }

    // Find user with pinHash field (like your login flow)
    const user = await User.findById(userId).select('+pinHash');
    
    if (!user) {
      console.log('❌ User not found for userId:', userId);
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Check if user has a login PIN set
    if (!user.pinHash) {
      console.log('❌ No PIN set for userId:', userId);
      return res.status(400).json({
        success: false,
        message: 'No login PIN set for this account',
      });
    }

    // Verify current PIN (same logic as your verifyLoginPin)
    const isMatch = await bcrypt.compare(String(currentPin), user.pinHash);
    if (!isMatch) {
      console.log('❌ Invalid current PIN for userId:', userId);
      return res.status(400).json({
        success: false,
        message: 'Current PIN is incorrect',
      });
    }

    // Hash and save new PIN (convert to string like your setPin does)
    user.pinHash = String(newPin);
    await user.save(); // Pre-save hook will handle hashing

    console.log('✅ Login PIN changed successfully for user:', userId);

    res.json({
      success: true,
      message: 'Login PIN changed successfully',
    });
  } catch (error) {
    console.error('❌ Change Login PIN Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while changing login PIN',
    });
  }
};




// transaction PIN verification middleware

exports.setTransactionPin = async (req, res) => {
  try {
    const { pin } = req.body;
    const userId = req.user.id || req.user._id;

    // Validate PIN format
    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ 
        success: false,
        message: "Transaction PIN must be exactly 4 digits" 
      });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: "User not found" 
      });
    }

    // Optional: Check if PIN already exists
    if (user.transactionPinHash) {
      return res.status(400).json({
        success: false,
        message: "Transaction PIN already set. Please use reset PIN instead."
      });
    }

    console.log('🔐 Before setting PIN - user:', {
      userId: user._id,
      hasTransactionPinHash: !!user.transactionPinHash
    });

    // Set PIN (will be hashed by pre-save hook)
    user.transactionPinHash = pin;
    await user.save();

    // ✅ FIX: Verify the PIN was actually saved by querying with explicit inclusion
    const updatedUser = await User.findById(userId).select('+transactionPinHash');
    console.log('🔐 After setting PIN - user:', {
      userId: updatedUser._id,
      hasTransactionPinHash: !!updatedUser.transactionPinHash,
      transactionPinHash: updatedUser.transactionPinHash ? '***' : 'null' // Don't log actual hash
    });

    console.log('✅ Transaction PIN set for user:', userId);

    // Return success with PIN status
    res.status(200).json({ 
      success: true, 
      message: "Transaction PIN set successfully",
      transactionPinSet: true
    });

  } catch (error) {
    console.error('❌ Set Transaction PIN Error:', error);
    res.status(500).json({ 
      success: false,
      message: "Failed to set transaction PIN. Please try again." 
    });
  }
};



// 1. Forgot Login PIN (public)
exports.forgotLoginPin = async (req, res) => {
  const { phone } = req.body;
  const normalized = toE164(phone);
  const user = await User.findOne({ phone: normalized });
  if (!user) return res.status(404).json({ success: false, message: "User not found" });

  const code = generateAlphanumericOTP();
  user.resetCode = code;
  user.resetCodeExpires = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  const { devOtp } = await dispatchOtp(user.phone, user.email, code);

  res.json({
    success: true,
    message: "Your access key has been sent. It may take up to 2 minutes to arrive.",
    ...(devOtp && { devOtp }),
  });
};

// 2. Verify Reset Code
exports.verifyResetCode = async (req, res) => {
  const { phone, code } = req.body;
  const normalized = toE164(phone);
  const submittedCode = String(code || "").trim().toUpperCase();

  const user = await User.findOne({ phone: normalized }).select('+resetCode +resetCodeExpires');

  if (!user) {
    return res.status(400).json({ success: false, message: "Invalid or expired code" });
  }

  if (!user.resetCode || user.resetCode !== submittedCode) {
    return res.status(400).json({ success: false, message: "Invalid or expired code" });
  }

  if (!user.resetCodeExpires || user.resetCodeExpires < new Date()) {
    return res.status(400).json({ success: false, message: "Invalid or expired code" });
  }

  user.resetCode = undefined;
  user.resetCodeExpires = undefined;
  await user.save();

  const resetToken = jwt.sign({ id: user._id, type: "pin_reset" }, process.env.JWT_SECRET, {
    expiresIn: "15m",
  });

  res.json({ success: true, resetToken });
};

// 3. Set PIN after reset (uses resetToken)
exports.setPinAfterReset = async (req, res) => {
  const { resetToken, pin } = req.body;

  let decoded;
  try {
    decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    if (decoded.type !== "pin_reset") throw new Error();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid reset token" });
  }

  const user = await User.findById(decoded.id);
  if (!user) return res.status(404).json({ success: false, message: "User not found" });

  user.pinHash = pin; // pre-save hook hashes this
  user.requirePinOnOpen = true;
  await user.save();

  res.json({ success: true, message: "PIN updated successfully" });
};

// 4. Update Require PIN on Open
exports.updateRequirePinOnOpen = async (req, res) => {
  const { requirePin } = req.body;
  req.user.requirePinOnOpen = requirePin;
  await req.user.save();
  res.json({ success: true });
};

exports.resetTransactionPin = async (req, res) => {
  try {
    const { pin, otp } = req.body;
    const userId = req.user.id;
    const user = await User.findById(userId).select("+phoneOTP +phoneOTPExpires");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!user.phoneOTP || !user.phoneOTPExpires || user.phoneOTPExpires < Date.now()) {
      return res.status(403).json({ message: "Invalid or expired OTP" });
    }
    const isValidOTP = await bcrypt.compare(String(otp).trim().toUpperCase(), user.phoneOTP);
    if (!isValidOTP) {
      return res.status(403).json({ message: "Invalid or expired OTP" });
    }
    user.transactionPinHash = pin; // hashed by pre-save hook
    user.phoneOTP = undefined;
    user.phoneOTPExpires = undefined;
    await user.save();
    res.status(200).json({ success: true, message: "Transaction PIN reset successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.resetLoginPin = async (req, res) => {
  try {
    const { pin, otp } = req.body;
    const userId = req.user.id;
    const user = await User.findById(userId).select("+phoneOTP +phoneOTPExpires");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!user.phoneOTP || !user.phoneOTPExpires || user.phoneOTPExpires < Date.now()) {
      return res.status(403).json({ message: "Invalid or expired OTP" });
    }
    const isValidOTP = await bcrypt.compare(String(otp).trim().toUpperCase(), user.phoneOTP);
    if (!isValidOTP) {
      return res.status(403).json({ message: "Invalid or expired OTP" });
    }
    user.pinHash = pin; // hashed by pre-save hook
    user.phoneOTP = undefined;
    user.phoneOTPExpires = undefined;
    await user.save();
    res.status(200).json({ success: true, message: "Login PIN reset successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


exports.updateProfile = async (req, res, next) => {
  try {
    const userId = req.user.id || req.user._id;
    const { firstName, lastName, email } = req.body;

    const updates = {};
    if (firstName && firstName.trim()) updates.firstName = firstName.trim();
    if (lastName && lastName.trim()) updates.lastName = lastName.trim();
    if (email && email.trim()) updates.email = email.trim().toLowerCase();

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    const user = await User.findByIdAndUpdate(userId, updates, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: maskPhone(user.phone),
        profileImage: user.profileImage,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Email already in use' });
    }
    next(error);
  }
};

exports.changeTransactionPin = async (req, res, next) => {
  try {
    const { currentPin, newPin } = req.body;
    const userId = req.user.id || req.user._id;

    if (!currentPin || !/^\d{4}$/.test(currentPin)) {
      return res.status(400).json({ success: false, message: 'Current PIN must be 4 digits' });
    }
    if (!newPin || !/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ success: false, message: 'New PIN must be 4 digits' });
    }
    if (currentPin === newPin) {
      return res.status(400).json({ success: false, message: 'New PIN must differ from current PIN' });
    }

    const user = await User.findById(userId).select('+transactionPinHash');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.transactionPinHash) {
      return res.status(400).json({ success: false, message: 'No transaction PIN set. Please set one first.' });
    }

    const isMatch = await bcrypt.compare(String(currentPin), user.transactionPinHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current PIN is incorrect' });
    }

    user.transactionPinHash = String(newPin);
    await user.save();

    return res.json({ success: true, message: 'Transaction PIN changed successfully' });
  } catch (error) {
    next(error);
  }
};

exports.deleteAccount = async (req, res, next) => {
  try {
    const { pin } = req.body;
    const userId = req.user.id || req.user._id;

    if (!pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'Your 6-digit login PIN is required to delete your account' });
    }

    const user = await User.findById(userId).select('+pinHash');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isMatch = await bcrypt.compare(String(pin), user.pinHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect PIN' });
    }

    await User.findByIdAndUpdate(userId, { isActive: false, email: null, phone: `deleted_${userId}` });

    return res.json({ success: true, message: 'Account deleted successfully' });
  } catch (error) {
    next(error);
  }
};

exports.savePushToken = async (req, res, next) => {
  try {
    const { token } = req.body;
    const userId = req.user.id || req.user._id;
    if (!token) return res.status(400).json({ success: false, message: 'token is required' });
    await User.findByIdAndUpdate(userId, { expoPushToken: token });
    return res.json({ success: true });
  } catch (error) { next(error); }
};

exports.uploadProfilePhoto = async (req, res, next) => {
  try {
    const userId = req.user.id || req.user._id;

    // Accept base64 data URI sent from React Native
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'imageBase64 is required' });
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME === 'your_cloud_name') {
      return res.status(503).json({ success: false, message: 'Photo upload is not configured yet.' });
    }

    const result = await cloudinary.uploader.upload(imageBase64, {
      folder:         'payflex/profile_photos',
      public_id:      `user_${userId}`,
      overwrite:      true,
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
    });

    const user = await User.findByIdAndUpdate(
      userId,
      { profileImage: result.secure_url },
      { new: true }
    );

    return res.json({
      success: true,
      message: 'Profile photo updated',
      profileImage: user.profileImage,
    });
  } catch (error) {
    console.error('❌ Upload profile photo error:', error.message);
    next(error);
  }
};

// adding fund to wallet balance

exports.addTestFunds = async (req, res, next) => {
  try {
    const { amount } = req.body;
    const userId = req.user.id; // From auth middleware

    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    // Find user and update balance
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Add funds
    user.walletBalance = (user.walletBalance || 0) + Number(amount);
    await user.save();

    console.log(`✅ Added ₦${amount} to ${maskPhone(user.phone)}`);

    return res.status(200).json({
      success: true,
      message: `₦${amount} added to your wallet`,
      walletBalance: user.walletBalance,
    });

  } catch (error) {
    console.error("❌ Error adding test funds:", error);
    next(error);
  }
};



exports.me = async (req, res, next) => {
  try {
    // Fetch fresh user data from database
    const u = await User.findById(req.user.id || req.user._id)
      .select('-password +transactionPinHash')  // ✅ FIX: Explicitly include transactionPinHash
      .lean();  // Convert to plain object for better performance
    
    if (!u) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Log for debugging
    console.log('📡 /me endpoint - Fresh DB query:', {
      userId: u._id,
      hasTransactionPinHash: !!u.transactionPinHash,
      transactionPinHash: u.transactionPinHash, // This will now show the actual value
      walletBalance: u.walletBalance
    });
    
    // Return fresh data with PIN status
    res.json({
      success: true,
      user: {
        id: u._id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        phone: u.phone,
        isPhoneVerified: u.isPhoneVerified,
        kyc: u.kyc,
        walletBalance: u.walletBalance || 0,
        roles: u.roles,
        profileImage: u.profileImage || null,
      },
      transactionPinSet: !!u.transactionPinHash
    });
  } catch (e) {
    console.error('❌ /me endpoint error:', e);
    next(e);
  }
};


