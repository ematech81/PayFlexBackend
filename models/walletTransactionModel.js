
const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['credit', 'debit'], // credit = add money, debit = remove money
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  balanceBefore: Number,
  balanceAfter: Number,
  description: String,
  reference: String,
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'success'
  },
  metadata: Object, // Extra info like service type, payment method
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);