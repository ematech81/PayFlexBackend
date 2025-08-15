const express = require("express");
const { body } = require("express-validator");
const { makePayment } = require("../controllers/vtpassController");

const router = express.Router();

router.post(
  "/pay",
  [
    body("serviceType").notEmpty().withMessage("Service type is required"),
    body("phoneNumber")
      .isMobilePhone()
      .withMessage("Valid phone number is required"),
    body("amount").isNumeric().withMessage("Amount must be a number"),
  ],
  makePayment
);

module.exports = router;
