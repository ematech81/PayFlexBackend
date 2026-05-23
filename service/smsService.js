const axios = require("axios");

const IS_PROD = process.env.NODE_ENV === "production";

const sendchamp = axios.create({
  baseURL: process.env.SENDCHAMP_BASE_URL || "https://api.sendchamp.com/api/v1",
  headers: {
    Authorization: `Bearer ${process.env.SENDCHAMP_PUBLIC_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

/**
 * Send an OTP via SendChamp SMS.
 *
 * Production  → real SMS delivered via SendChamp.
 * Development → OTP is logged to the console and returned as `devOtp`
 *               so the frontend can pre-fill the input field.
 *
 * @param {string} phone  E.164-formatted phone number (+234XXXXXXXXXX)
 * @param {string} otp    The OTP code to deliver
 * @param {number} expiryMinutes  How long until the OTP expires (shown in message)
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

  try {
    const response = await sendchamp.post("/sms/send", {
      to: [phone],
      message: `Your PayFlex verification code is ${otp}. Valid for ${expiryMinutes} minutes. Do not share this code with anyone.`,
      sender_name: "PayFlex",
      route: "dnd", // reaches DND-registered Nigerian numbers
    });

    if (response.data?.status !== "success") {
      throw new Error(response.data?.message || "SMS delivery failed");
    }

    console.log(`✅ OTP sent via SendChamp to ${phone.slice(0, 7)}***`);
    return {};
  } catch (error) {
    const detail = error.response?.data?.message || error.message;
    console.error(`❌ SendChamp SMS error for ${phone.slice(0, 7)}***:`, detail);
    throw new Error("Failed to send verification code. Please try again.");
  }
};

module.exports = { sendOtp };
