// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const verifyPin = require("../middleware/verifyPin");

// Example: Buy Airtime
router.post("/buy-airtime", protect, verifyPin, async (req, res, next) => {
  try {
    const { phoneNumber, amount, network } = req.body;

    // Here you would call VTpass API or other payment service
    // Example:
    // const response = await axios.post("https://vtpass.com/api/pay", {...})

    res.json({ message: "Airtime purchase successful" });
  } catch (err) {
    next(err);
  }
});

// Example: Pay Electricity Bill
router.post("/pay-electricity", protect, verifyPin, async (req, res, next) => {
  try {
    const { meterNumber, amount, disco } = req.body;

    // Call VTpass Electricity Payment API here

    res.json({ message: "Electricity bill paid successfully" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
