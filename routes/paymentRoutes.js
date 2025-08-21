const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const verifyPin = require("../middleware/verifyPin");
const {
  makePayment,
  verifyTransaction,
  getDataPlans,
} = require("../controllers/paymentController"); // Adjust path to your controller

// Buy Airtime
router.post("/buy-airtime", protect, verifyPin, async (req, res, next) => {
  try {
    const { phoneNumber, amount, network } = req.body;

    // Validate required fields
    if (!phoneNumber || !amount || !network) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Map network to VTpass serviceID (e.g., mtn, glo)
    const serviceID = `${network.toLowerCase()}-airtime`;

    // Call makePayment function (assumes it's in paymentController)
    const response = await makePayment(req, res, {
      serviceID,
      phoneNumber,
      amount,
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// Get Data Plans for a network
router.get("/data-plans", getDataPlans);

// router.get("/data-plans", async (req, res, next) => {
//   try {
//     const { network } = req.query;
//     if (!network) {
//       return res
//         .status(400)
//         .json({ success: false, error: "Network is required" });
//     }
//     await getDataPlans(req, res, network);
//   } catch (err) {
//     next(err);
//   }
// });

// Buy Data
router.post("/buy-data", protect, verifyPin, async (req, res, next) => {
  try {
    const { phoneNumber, amount, network, variation_code } = req.body;

    // Validate required fields
    if (!phoneNumber || !amount || !network || !variation_code) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Map network to VTpass serviceID (e.g., mtn-data, glo-data)
    const serviceID = `${network.toLowerCase()}-data`;

    // Call makePayment function
    const response = await makePayment(req, res, {
      serviceID,
      phoneNumber,
      amount,
      variation_code,
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// Pay Electricity Bill
router.post("/pay-electricity", protect, verifyPin, async (req, res, next) => {
  try {
    const { meterNumber, amount, disco } = req.body;

    // Validate required fields
    if (!meterNumber || !amount || !disco) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Map disco to VTpass serviceID (e.g., ikedc, eedc)
    const serviceID = `${disco.toLowerCase()}-prepaid`; // Adjust based on VTpass disco codes

    // Call makePayment function (use meterNumber as billersCode)
    const response = await makePayment(req, res, {
      serviceID,
      billersCode: meterNumber,
      amount,
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// Verify Transaction
router.get(
  "/verify-transaction/:reference",
  protect,
  async (req, res, next) => {
    try {
      const { reference } = req.params;

      if (!reference) {
        return res.status(400).json({ message: "Reference is required" });
      }

      const response = await verifyTransaction(req, res, { reference });
      res.json(response);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
