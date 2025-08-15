const express = require("express");
const { body } = require("express-validator");
const {
  setPin, 
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

const router = express.Router();

// Set transaction PIN
router.post("/set", protect, [body("pin").notEmpty()], setPin);

module.exports = router;
