const bulkSms = require("./bulkSmsService");

/**
 * Send an access-key SMS via BulkSMS Nigeria.
 *
 * Real SMS is sent whenever BULKSMS_API_TOKEN is set in the environment.
 * If the token is missing (local dev without .env), the OTP is logged to
 * the console and returned as `devOtp` so the frontend can pre-fill it.
 * This is intentionally decoupled from NODE_ENV so Railway deployments
 * work correctly regardless of how NODE_ENV is configured.
 */
const sendOtp = async (phone, otp, expiryMinutes = 10) => {
  const hasToken = !!process.env.BULKSMS_API_TOKEN;

  if (!hasToken) {
    console.log("\n📱 [DEV OTP — no BULKSMS_API_TOKEN set] ──────────────");
    console.log(`   Phone  : ${phone}`);
    console.log(`   OTP    : ${otp}`);
    console.log(`   Expiry : ${expiryMinutes} minutes`);
    console.log("──────────────────────────────────────────────────────\n");
    return { devOtp: otp };
  }

  await bulkSms.sendOTP(phone, otp);
  console.log(`✅ Access key sent via BulkSMS to ${phone.slice(0, 7)}***`);
  return {};
};

module.exports = { sendOtp };
