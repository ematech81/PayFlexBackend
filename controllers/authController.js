const { validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/user");




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
 * Generates a secure 6-digit numeric OTP
 * @returns {String} 6-digit OTP string
 */
const generateOtp = () => crypto.randomInt(100000, 999999).toString();

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

// ---------- SMS Service Configuration ----------
const twilio = require("twilio");
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

/**
 * Sends OTP via Twilio SMS
 * Falls back to console logging in development
 * @param {String} phone - Recipient phone number
 * @param {String} otp - OTP code to send
 */
async function sendSmsOtp(phone, otp) {
  const to = toE164(phone);
  
  // Development fallback - log OTP to console
  if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) {
    console.log(`⚠️  [DEV MODE] Twilio not configured`);
    console.log(`📱 Phone: ${to}`);
    console.log(`🔐 OTP: ${otp}`);
    console.log(`⏰ Expires in: ${OTP_EXP_MIN} minutes`);
    return;
  }

  // Production - send actual SMS
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body: `Your PayFlex verification code is ${otp}. It expires in ${OTP_EXP_MIN} minutes.`,
    });
    console.log(`✅ OTP sent to ${maskPhone(phone)}`);
  } catch (error) {
    console.error(`❌ Failed to send OTP to ${maskPhone(phone)}:`, error.message);
    throw new Error("Failed to send verification code. Please try again.");
  }
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
      return res.status(400).json({ 
        success: false,
        errors: errors.array() 
      });
    }

    const { firstName, lastName, email, phone, password } = req.body;

    // Step 2: Check for existing user
    const existingUser = await User.findOne({
      $or: [
        { email: email?.toLowerCase() },
        { phone: toE164(phone) }
      ],
    });

    if (existingUser) {
      const field = existingUser.email === email?.toLowerCase() ? "Email" : "Phone number";
      return res.status(409).json({ 
        success: false,
        message: `${field} already registered. Please login instead.`
      });
    }

    // Step 3: Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Step 4: Create new user
    const user = await User.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email?.toLowerCase().trim(),
      phone: toE164(phone),
      passwordHash,
      isEmailVerified: false,
      isPhoneVerified: false,
      devices: [],
      walletBalance: 0,
      kyc: "pending",
      roles: ["user"],
      isActive: true,
    });

    // Step 5: Generate OTP
    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXP_MIN * 60 * 1000);

    // Step 6: Store hashed OTP and expiry
    user.phoneOTP = otpHash;
    user.phoneOTPExpires = expiresAt;
    await user.save();

    // Step 7: Send OTP via SMS
    try {
      await sendSmsOtp(user.phone, otp);
    } catch (smsError) {
      // If SMS fails, delete the user to maintain data integrity
      await User.findByIdAndDelete(user._id);
      return res.status(500).json({
        success: false,
        message: "Failed to send verification code. Please try again.",
      });
    }

    // Step 8: Return success response
    return res.status(201).json({
      success: true,
      message: "Registration successful. We sent a code to your phone.",
      userId: user._id,
      phone: maskPhone(user.phone),
      expiresInMinutes: OTP_EXP_MIN,
    });

  } catch (error) {
    console.error("❌ Registration error:", error);
    
    // Handle specific MongoDB errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        success: false,
        message: `${field} already exists`,
      });
    }

    // Pass to error handling middleware
    next(error);
  }
};




/**
 * POST /api/auth/phone/verify
 * Body: { userId, otp }
 * Public (verifies right after registration)
 * On success: marks phone verified, clears OTP, returns JWT + user
 */


/**
 * Converts Nigerian phone numbers to E.164 format
 * @param {String} phone - Phone number
 * @returns {String} E.164 formatted phone (+234xxxxxxxxxx)
 */

function toE164(phone) {
  const p = (phone || "").trim();
  if (p.startsWith("+")) return p;
  if (/^0[789]\d{9}$/.test(p)) return `+234${p.slice(1)}`;
  if (/^234[789]\d{9}$/.test(p)) return `+${p}`;
  return p;
}

/**
 * Masks phone number for secure display
 * @param {String} phone - Phone number
 * @returns {String} Masked phone (****1234)
 */
function maskPhone(phone) {
  if (!phone) return null;
  const last4 = phone.slice(-4);
  return `****${last4}`;
}



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
    // Step 1: Validate input
    const { phone, otp, deviceId } = req.body; // Accept deviceId from frontend

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone number and OTP are required",
      });
    }

    // Validate OTP format (6 digits)
    if (!/^\d{6}$/.test(otp.trim())) {
      return res.status(400).json({
        success: false,
        message: "OTP must be exactly 6 digits",
      });
    }

    // Step 2: Normalize phone to E.164 format
    const normalizedPhone = toE164(phone);

    console.log(`📱 Verifying phone OTP for: ${maskPhone(normalizedPhone)}`);

    // Step 3: Find user by phone (include OTP fields and devices for verification)
    const user = await User.findOne({ phone: normalizedPhone })
      .select("+phoneOTP +phoneOTPExpires +devices");

    if (!user) {
      console.log(`❌ User not found for phone: ${maskPhone(normalizedPhone)}`);
      return res.status(404).json({
        success: false,
        message: "User not found. Please register first.",
      });
    }

    // Step 4: Check if phone is already verified
    if (user.isPhoneVerified) {
      return res.status(400).json({
        success: false,
        message: "Phone number already verified. Please login.",
        alreadyVerified: true,
      });
    }

    // Step 5: Check if OTP exists
    if (!user.phoneOTP || !user.phoneOTPExpires) {
      return res.status(400).json({
        success: false,
        message: "No verification code found. Please request a new one.",
        shouldResend: true,
      });
    }

    // Step 6: Check if OTP is expired
    const now = Date.now();
    const expiryTime = new Date(user.phoneOTPExpires).getTime();

    if (now > expiryTime) {
      const expiredMinutes = Math.floor((now - expiryTime) / 60000);
      
      console.log(`⏰ OTP expired ${expiredMinutes} minutes ago for ${maskPhone(normalizedPhone)}`);
      
      return res.status(400).json({
        success: false,
        message: "Verification code expired. Please request a new one.",
        isExpired: true,
        shouldResend: true,
      });
    }

    // Step 7: Verify OTP
    const isValidOTP = await bcrypt.compare(String(otp.trim()), user.phoneOTP);

    if (!isValidOTP) {
      console.log(`❌ Invalid OTP attempt for ${maskPhone(normalizedPhone)}`);
      
      return res.status(400).json({
        success: false,
        message: "Invalid verification code. Please try again.",
      });
    }

    // Step 8: Mark phone as verified and clear OTP
    user.isPhoneVerified = true;
    user.phoneOTP = undefined;
    user.phoneOTPExpires = undefined;
    user.lastLogin = new Date();

    // Step 9: ✅ ADD DEVICE TO TRUSTED DEVICES (NEW FIX)
    if (deviceId) {
      const normalizedDeviceId = deviceId.trim().toLowerCase();
      
      // Initialize devices array if it doesn't exist
      if (!user.devices) {
        user.devices = [];
      }

      // Only add if not already in list (case-insensitive check)
      const deviceExists = user.devices
        .map(d => d.toLowerCase())
        .includes(normalizedDeviceId);

      if (!deviceExists) {
        user.devices.push(normalizedDeviceId);
        console.log(`✅ Device added during phone verification for ${maskPhone(normalizedPhone)}`);
      } else {
        console.log(`ℹ️  Device already in list for ${maskPhone(normalizedPhone)}`);
      }
    } else {
      console.log(`⚠️  No deviceId provided during phone verification for ${maskPhone(normalizedPhone)}`);
    }
    
    await user.save();

    console.log(`✅ Phone verified successfully for ${maskPhone(normalizedPhone)}`);

    // Step 10: Generate JWT token
    const token = signToken(user);

    // Step 11: Return success response
    return res.status(200).json({
      success: true,
      message: "Phone verified successfully",
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
        requirePinOnOpen: user.requirePinOnOpen,
      },
    });

  } catch (error) {
    console.error("❌ Phone OTP verification error:", error);

    // Handle specific MongoDB errors
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number format",
      });
    }

    // Pass to error handling middleware
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

      // Send OTP via SMS
      await sendSmsOtp(user.phone, otp);

      return res.status(200).json({
        success: true,
        isNewDevice: true,
        message: "New device detected. We sent a verification code to your phone.",
        phone: maskPhone(user.phone),
        expiresInMinutes: OTP_EXP_MIN,
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

    if (!/^\d{6}$/.test(otp.trim())) {
      return res.status(400).json({
        success: false,
        message: "OTP must be exactly 6 digits",
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
    const isValidOTP = await bcrypt.compare(String(otp.trim()), user.phoneOTP);

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

    await sendSmsOtp(user.phone, otp);

    console.log(`✅ Device OTP resent to ${maskPhone(normalizedPhone)}`);

    return res.status(200).json({
      success: true,
      message: "Verification code sent successfully",
      expiresInMinutes: OTP_EXP_MIN,
    });

  } catch (error) {
    console.error("❌ Resend device OTP error:", error);
    next(error);
  }
};




//set login pin after phone verification
exports.setPin = async (req, res, next) => {
  try {
    const { userId, pin } = req.body;
    console.log("Setting login PIN for userId:", userId, "PIN:", pin);

    // ✅ Validate input
    if (!userId || !pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: "userId and a valid 6-digit PIN are required",
      });
    }

    // ✅ Find user
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
    console.log("Verify login PIN attempt:", { phone, pin });
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

    console.log(
      "Comparing PIN for phone:",
      phone,
      "Stored pinHash:",
      user.pinHash
    );
    const isMatch = await bcrypt.compare(String(pin), user.pinHash);
    console.log("PIN match result:", isMatch);
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
  const user = await User.findOne({ phone });
  if (!user) return res.status(404).json({ success: false, message: "User not found" });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  user.resetCode = code;
  user.resetCodeExpires = Date.now() + 10 * 60 * 1000; // 10 min
  await user.save();

  // Send via SMS
  await sendSMS(phone, `PayFlex PIN Reset Code: ${code}`);
  if (user.email) await sendEmail(user.email, "PIN Reset", `Your code: ${code}`);

  res.json({ success: true, message: "Reset code sent" });
};

// 2. Verify Reset Code
exports.verifyResetCode = async (req, res) => {
  const { phone, code } = req.body;
  const user = await User.findOne({
    phone,
    resetCode: code,
    resetCodeExpires: { $gt: Date.now() },
  });

  if (!user) {
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

  const salt = await bcrypt.genSalt(10);
  user.loginPin = await bcrypt.hash(pin, salt);
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
      },
      transactionPinSet: !!u.transactionPinHash  // ← This will now work correctly!
    });
  } catch (e) {
    console.error('❌ /me endpoint error:', e);
    next(e);
  }
};


