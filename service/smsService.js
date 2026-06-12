const bulkSms = require("./bulkSmsService");

const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Send an access-key SMS via BulkSMS Nigeria.
 *
 * Production  → real SMS delivered via BulkSMS Nigeria.
 * Development → OTP is logged to the console and returned as `devOtp`
 *               so the frontend can pre-fill the input field.
 *
 * @param {string} phone  E.164-formatted phone number (+234XXXXXXXXXX)
 * @param {string} otp    The OTP code to deliver
 * @param {number} expiryMinutes  How long until the OTP expires (unused — message wording is fixed by bulkSmsService)
 * @returns {Promise<{ devOtp?: string }>}  devOtp is present only in development
 */
const sendOtp = async (phone, otp, expiryMinutes = 10) => {
  if (!IS_PROD) {
    console.log("\n📱 [DEV OTP] ──────────────────────────");
    console.log(`   Phone  : ${phone}`);
    console.log(`   OTP    : ${otp}`);
    console.log(`   Expiry : ${expiryMinutes} minutes`);
    console.log("────────────────────────────────────────\n");
    return { devOtp: otp };
  }

  await bulkSms.sendOTP(phone, otp);
  console.log(`✅ Access key sent via BulkSMS to ${phone.slice(0, 7)}***`);
  return {};
};

module.exports = { sendOtp };
