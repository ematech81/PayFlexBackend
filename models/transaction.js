const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  // Core transaction fields
  serviceID: {
    type: String,
    required: true,
    index: true,
  },
  phoneNumber: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  reference: {
    type: String,
    unique: true,
    required: true,
    index: true,
  },
  request_id: {
    type: String,
    index: true,
  },
  
  // Transaction status
  status: {
    type: String,
    enum: ["pending", "success", "failed"],
    default: "pending",
    index: true,
  },
  transactionId: {
    type: String,
    index: true,
  },
  
  // Transaction type
  type: {
    type: String,
    enum: [
      "airtime",
      "data", 
      "electricity",
      "tv", 
      "education",
      "other", 
      "nin_verification",        
      "nin_phone_search",         
      "nin_tracking_search",      
      "bvn_verification",         
      "bvn_phone_search", 
      "transport_booking",
      "transport_refund",
      "flight_booking",      
      "flight_refund",   
    ],
    default: "airtime",
    index: true,
  },
  
  // Service-specific fields
  billersCode: {
    type: String,
    // For electricity: meter number
    // For TV: smartcard/IUC number
    // For education: registration number
  },
  variation_code: {
    type: String,
    // For data: data plan code
    // For electricity: prepaid/postpaid
    // For TV: bouquet code
    // For education: exam type
  },
  
  // TV subscription specific
  subscription_type: {
    type: String,
    enum: ["change", "renew"],
    // Only for TV subscriptions
  },
  quantity: {
    type: Number,
    default: 1,
    // For multi-month TV subscriptions or bulk purchases
  },
  purchasedCode: {
    type: String,
    // Token/code returned for certain services (e.g., TV, education)
  },
  
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  
  // Response data
  response: {
    type: Object,
    // Full VTPass API response
  },
  failureReason: {
    type: String,
    // Reason for failed transactions
  },
  
  // Metadata
  commission: {
    type: Number,
    default: 0,
  },
  discount: {
    type: Number,
    default: 0,
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  verificationData: {
    nin: String,
    bvn: String,
    firstName: String,
    middleName: String,
    surname: String,
    phoneNumber: String,
    dateOfBirth: String,
    gender: String,
    residenceState: String,
    residenceLGA: String,
    residenceAddress: String,
    photo: String, // Base64 image
    reportId: String,
  },
}, {
  timestamps: true, // Automatically manage createdAt and updatedAt
});

// Indexes for common queries
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, type: 1 });
transactionSchema.index({ reference: 1, userId: 1 });

// Pre-save middleware to update updatedAt
transactionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Instance method to check if transaction is successful
transactionSchema.methods.isSuccessful = function() {
  return this.status === 'success';
};

// Instance method to check if transaction is pending
transactionSchema.methods.isPending = function() {
  return this.status === 'pending';
};

// Instance method to check if transaction is failed
transactionSchema.methods.isFailed = function() {
  return this.status === 'failed';
};

// Static method to get user transactions
transactionSchema.statics.getUserTransactions = function(userId, options = {}) {
  const {
    limit = 50,
    skip = 0,
    status,
    type,
    startDate,
    endDate,
  } = options;

  const query = { userId };

  if (status) query.status = status;
  if (type) query.type = type;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip)
    .lean();
};

// Static method to get transaction by reference
transactionSchema.statics.getByReference = function(reference) {
  return this.findOne({ reference }).lean();
};

// Static method to get transaction statistics
transactionSchema.statics.getStats = async function(userId, period = 'month') {
  const now = new Date();
  let startDate;

  switch (period) {
    case 'day':
      startDate = new Date(now.setHours(0, 0, 0, 0));
      break;
    case 'week':
      startDate = new Date(now.setDate(now.getDate() - 7));
      break;
    case 'month':
      startDate = new Date(now.setMonth(now.getMonth() - 1));
      break;
    case 'year':
      startDate = new Date(now.setFullYear(now.getFullYear() - 1));
      break;
    default:
      startDate = new Date(now.setMonth(now.getMonth() - 1));
  }

  return this.aggregate([
    {
      $match: {
        userId: mongoose.Types.ObjectId(userId),
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        successCount: {
          $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] },
        },
        failedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
        },
      },
    },
  ]);
};

// ============================================
// ✅ EXPORT WITH OVERWRITE PROTECTION
// ============================================
// This prevents "Cannot overwrite Transaction model" error
module.exports = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);