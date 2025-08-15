const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  serviceType: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: "pending" },
  reference: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Transaction", transactionSchema);
