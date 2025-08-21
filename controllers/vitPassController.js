const axios = require("axios");
const Transaction = require("../models/transaction");

// Middleware to configure axios with VTpass base URL and auth
const vtpassApi = axios.create({
  baseURL:
    process.env.VTPASS_ENV === "sandbox"
      ? "https://sandbox.vtpass.com/api"
      : "https://api.vtpass.com/api",
  auth: {
    username: process.env.VTPASS_API_KEY,
    password: process.env.VTPASS_SECRET_KEY,
  },
});

const makePayment = async (req, res) => {
  const { serviceID, phoneNumber, amount, billersCode } = req.body; // billersCode for services like DSTV
  const reference = `ref_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`; // Unique request_id

  try {
    // Validate required fields
    if (!serviceID || !phoneNumber || !amount) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields" });
    }

    // Create transaction record
    const newTransaction = new Transaction({
      serviceID,
      phoneNumber,
      amount,
      reference,
      status: "pending",
    });
    await newTransaction.save();

    // VTpass payload (adjust based on service)
    const payload = {
      request_id: reference,
      serviceID,
      billersCode: billersCode || phoneNumber, // Use phone for airtime/data, smartcard for DSTV
      amount,
      variation_code: req.body.variation_code || "", // Optional for data plans
    };

    const response = await vtpassApi.post("/pay", payload);

    // Update transaction based on VTpass response
    if (
      response.data.code === "000" ||
      response.data.response_description === "TRANSACTION SUCCESSFUL"
    ) {
      newTransaction.status = "success";
      newTransaction.transactionId = response.data.transactionId;
      newTransaction.response = response.data;
    } else {
      newTransaction.status = "failed";
      newTransaction.response = response.data;
    }
    await newTransaction.save();

    res.json({
      success: true,
      message: response.data.response_description || "Transaction processed",
      data: newTransaction,
    });
  } catch (error) {
    console.error("VTpass API Error:", error.response?.data || error.message);
    const transactionError = error.response?.data || {
      code: "999",
      response_description: "Internal server error",
    };
    await Transaction.findByIdAndUpdate(newTransaction._id, {
      status: "failed",
      response: transactionError,
    });

    res.status(500).json({
      success: false,
      error: transactionError.response_description || error.message,
      code: transactionError.code,
    });
  }
};

module.exports = { makePayment };
