const express = require("express");
const { buyAirtime } = require("../services/vtpassService");
const router = express.Router();

router.post("/airtime", async (req, res) => {
  const { serviceID, amount, phone } = req.body;

  // Generate unique request ID
  const request_id = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  try {
    const result = await buyAirtime({ request_id, serviceID, amount, phone });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Something went wrong" });
  }
});

module.exports = router;
