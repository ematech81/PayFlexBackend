const axios = require("axios");
const Transaction = require("../models/transaction");

const makePayment = async (req, res) => {
  const { serviceType, phoneNumber, amount } = req.body;

  try {
    const reference = `ref_${Date.now()}`;
    const newTransaction = new Transaction({
      serviceType,
      phoneNumber,
      amount,
      reference,
    });
    await newTransaction.save();

    const response = await axios.post(
      "https://vtpass.com/api/pay", // Change to actual VTpass endpoint
      {
        serviceID: serviceType,
        phone: phoneNumber,
        amount,
        request_id: reference,
      },
      {
        headers: {
          "api-key": process.env.VTPASS_API_KEY,
          "secret-key": process.env.VTPASS_SECRET_KEY,
        },
      }
    );

    newTransaction.status = response.data.code === "000" ? "success" : "failed";
    await newTransaction.save();

    res.json({
      success: true,
      message: "Transaction processed",
      data: newTransaction,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { makePayment };
