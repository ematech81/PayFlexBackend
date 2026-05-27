const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { timestamps: true }
);

customerSchema.index({ userId: 1, createdAt: -1 });

module.exports =
  mongoose.models.Customer || mongoose.model('Customer', customerSchema);
