// vtpassService.js
const axios = require("axios");

const VT_PASS_API_KEY = process.env.VTPASS_API_KEY;
const VT_PASS_SECRET_KEY = process.env.VTPASS_SECRET_KEY;

const BASE_URL = "https://sandbox.vtpass.com/api/pay";

async function buyAirtime({ request_id, serviceID, amount, phone }) {
  try {
    const res = await axios.post(
      BASE_URL,
      { request_id, serviceID, amount, phone },
      {
        headers: {
          "api-key": VT_PASS_API_KEY,
          "secret-key": VT_PASS_SECRET_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    return res.data;
  } catch (error) {
    console.error(
      "VTpass Airtime Error:",
      error.response?.data || error.message
    );
    throw new Error(error.response?.data || "VTpass request failed");
  }
}

module.exports = { buyAirtime };
