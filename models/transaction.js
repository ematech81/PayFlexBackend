const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  serviceID: String,
  phoneNumber: String,
  amount: Number,
  reference: { type: String, unique: true },
  status: {
    type: String,
    enum: ["pending", "success", "failed"],
    default: "pending",
  },
  transactionId: String,
  response: Object,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Transaction", transactionSchema);
