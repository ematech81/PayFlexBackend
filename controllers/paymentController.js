const axios = require("axios");
const Transaction = require("../models/transaction");

// Axios instance for VTpass API
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

const makePayment = async (
  req,
  res,
  { serviceID, phoneNumber, amount, billersCode, variation_code }
) => {
  const reference = `ref_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  try {
    const newTransaction = new Transaction({
      serviceID,
      phoneNumber,
      amount,
      reference,
      status: "pending",
      billersCode,
    });
    await newTransaction.save();

    const payload = {
      request_id: reference,
      serviceID,
      billersCode: billersCode || phoneNumber,
      amount,
      variation_code: variation_code || "",
    };

    const response = await vtpassApi.post("/pay", payload);

    if (
      response.data.code === "000" ||
      response.data.response_description === "TRANSACTION SUCCESSFUL"
    ) {
      newTransaction.status = "success";
      newTransaction.transactionId = response.data.transactionId;
    } else {
      newTransaction.status = "failed";
    }
    newTransaction.response = response.data;
    await newTransaction.save();

    return {
      success: true,
      message: response.data.response_description || "Transaction processed",
      data: newTransaction,
    };
  } catch (error) {
    const transactionError = error.response?.data || {
      code: "999",
      response_description: "Internal server error",
    };
    await Transaction.findByIdAndUpdate(newTransaction._id, {
      status: "failed",
      response: transactionError,
    });

    throw new Error(transactionError.response_description || error.message);
  }
};

// Fetch data plan variations from VTpass

// controllers/paymentController.js
const getDataPlans = async (req, res) => {
  try {
    const { network } = req.query;
    if (!network) {
      return res.status(400).json({ error: "Network is required" });
    }

    // map provider name to VTpass serviceID
    const serviceMap = {
      mtn: "mtn-data",
      airtel: "airtel-data",
      glo: "glo-data",
      "9mobile": "etisalat-data",
    };

    const serviceID = serviceMap[network.toLowerCase()];
    if (!serviceID) {
      return res.status(400).json({ error: "Invalid network provider" });
    }

    const response = await fetch(
      `https://sandbox.vtpass.com/api/service-variations?serviceID=${serviceID}`,
      {
        headers: {
          "api-key": process.env.VTPASS_API_KEY,
          "secret-key": process.env.VTPASS_SECRET_KEY,
          "public-key": process.env.VTPASS_PUBLIC_KEY,
        },
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Error fetching data plans:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const verifyTransaction = async (req, res, { reference }) => {
  try {
    const response = await vtpassApi.get(`/merchant-verify/${reference}`);

    if (response.data.code === "000") {
      const transaction = await Transaction.findOne({ reference });
      if (transaction) {
        transaction.status = response.data.content.status;
        transaction.response = response.data;
        await transaction.save();
      }
      return {
        success: true,
        message: "Transaction verified",
        data: response.data,
      };
    } else {
      return {
        success: false,
        message: response.data.response_description || "Verification failed",
        data: response.data,
      };
    }
  } catch (error) {
    const transactionError = error.response?.data || {
      code: "999",
      response_description: "Internal server error",
    };
    throw new Error(transactionError.response_description || error.message);
  }
};

module.exports = { makePayment, verifyTransaction, getDataPlans };
