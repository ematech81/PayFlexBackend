const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  // ============================================
  // CORE FIELDS (All Transaction Types)
  // ============================================
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  reference: {
    type: String,
    unique: true,   // unique already creates the index — no index:true needed
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "processing", "success", "failed", "completed", "refunded"],
    default: "pending",
    index: true,
  },
  type: {
    type: String,
    enum: [
      // VTPass services
      "airtime",
      "data", 
      "electricity",
      "tv", 
      "education",
      "other", 
      // Verification services
      "nin_verification",        
      "nin_phone_search",         
      "nin_tracking_search",      
      "bvn_verification",         
      "bvn_phone_search",
      // Booking services
      "transport_booking",
      "transport_refund",
      "flight_booking",      
      "flight_refund",
      // Wallet operations
      "wallet_topup",
      "wallet_withdrawal",
      "withdrawal",
      // Referral bonuses
      "referral_bonus",
      // VTU Africa services
      "airtime_conversion",
      "betting",
      "exam_pin",
    ],
    required: true,
    index: true,
  },
  
  // ============================================
  // VTPASS UTILITY FIELDS (Optional)
  // ============================================
  serviceID: {
    type: String,
    required: false, // ✅ Changed from true - Only for VTPass services
    index: true,
  },
  phoneNumber: {
    type: String,
    required: false, // ✅ Changed from true - Only for VTPass services
  },
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
  request_id: {
    type: String,
    index: true,
  },
  
  // ============================================
  // BOOKING FIELDS (Optional - For Flight/Transport)
  // ============================================
  bookingType: {
    type: String,
    enum: ["flight", "transport"],
    // Only for booking transactions
  },
  bookingReference: {
    type: String,
    // indexed via transactionSchema.index() below
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    // Reference to the actual booking document
  },
  
  // ============================================
  // PAYMENT METHOD
  // ============================================
  paymentMethod: {
    type: String,
    enum: ["wallet", "card", "bank_transfer", "ussd", "paystack", "flutterwave", "airtime"],
    default: "wallet",
  },
  
  // ============================================
  // TRANSACTION IDENTIFIERS
  // ============================================
  transactionId: {
    type: String,
    // indexed via transactionSchema.index() below
  },
  
  // ============================================
  // RESPONSE & ERROR DATA
  // ============================================
  response: {
    type: Object,
    // Full API response (VTPass, Amadeus, etc.)
  },
  failureReason: {
    type: String,
    // Reason for failed transactions
  },
  
  // ============================================
  // VERIFICATION DATA (Optional - For NIN/BVN)
  // ============================================
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
  
  // ============================================
  // FINANCIAL METADATA
  // ============================================
  commission: {
    type: Number,
    default: 0,
  },
  discount: {
    type: Number,
    default: 0,
  },
  currency: {
    type: String,
    default: "NGN",
  },

  // ============================================
  // REVENUE TRACKING (Pricing Service fields)
  // Populated at transaction creation time — never recomputed retroactively.
  // Pre-existing transactions have marginType:'unknown' and numeric fields at 0.
  // ============================================
  provider: {
    type: String,
    enum: ['vtpass', 'vtu-africa', 'kora-pay'],
  },
  userPaid: {
    type: Number,
    default: 0,
  },
  providerCost: {
    type: Number,
    default: 0,
  },
  providerFee: {
    type: Number,
    default: 0,
  },
  recipientFee: {
    type: Number,
    default: 0,
  },
  ourMargin: {
    type: Number,
    default: 0,
  },
  marginType: {
    type: String,
    enum: ['markup', 'service_fee', 'mixed', 'unknown'],
    default: 'unknown',
  },
  forSomeoneElse: {
    type: Boolean,
    default: false,
  },
  // VTU Africa only — 0 for all other providers
  vtuAfricaCommission: {
    type: Number,
    default: 0,
  },
  pricingConfigVersion: {
    type: String,
  },
  
  // ============================================
  // BOOKING METADATA (Optional)
  // ============================================
  metadata: {
    type: Object,
    default: {},
    // For bookings: route, airline, seats, etc.
    // For utilities: additional service details
  },
  
  // ============================================
  // TIMESTAMPS
  // ============================================
  paidAt: {
    type: Date,
    // When payment was actually processed
  },
  refundedAt: {
    type: Date,
    // When refund was processed (if applicable)
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true, // Automatically manage createdAt and updatedAt
});

// ============================================
// INDEXES
// ============================================
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, type: 1 });
transactionSchema.index({ reference: 1, userId: 1 });
transactionSchema.index({ bookingReference: 1 });
transactionSchema.index({ transactionId: 1 });

// ============================================
// PRE-SAVE MIDDLEWARE
// ============================================
transactionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  
  // Auto-set paidAt when status becomes success/completed
  if (this.isModified('status') && 
      (this.status === 'success' || this.status === 'completed') && 
      !this.paidAt) {
    this.paidAt = new Date();
  }
  
  // Auto-set refundedAt when status becomes refunded
  if (this.isModified('status') && this.status === 'refunded' && !this.refundedAt) {
    this.refundedAt = new Date();
  }
  
  next();
});

// ============================================
// VALIDATION MIDDLEWARE
// ============================================
transactionSchema.pre('validate', function(next) {
  // Validate VTPass transactions
  const vtpassTypes = ['airtime', 'data', 'electricity', 'tv', 'education'];
  if (vtpassTypes.includes(this.type)) {
    if (!this.serviceID) {
      return next(new Error('serviceID is required for VTPass transactions'));
    }
    if (!this.phoneNumber) {
      return next(new Error('phoneNumber is required for VTPass transactions'));
    }
  }
  
  // Validate booking transactions
  const bookingTypes = ['flight_booking', 'transport_booking', 'flight_refund', 'transport_refund'];
  if (bookingTypes.includes(this.type)) {
    if (!this.bookingReference) {
      return next(new Error('bookingReference is required for booking transactions'));
    }
  }
  
  next();
});

// ============================================
// INSTANCE METHODS
// ============================================
transactionSchema.methods.isSuccessful = function() {
  return this.status === 'success' || this.status === 'completed';
};

transactionSchema.methods.isPending = function() {
  return this.status === 'pending';
};

transactionSchema.methods.isFailed = function() {
  return this.status === 'failed';
};

transactionSchema.methods.isRefunded = function() {
  return this.status === 'refunded';
};

transactionSchema.methods.isBookingTransaction = function() {
  const bookingTypes = ['flight_booking', 'transport_booking', 'flight_refund', 'transport_refund'];
  return bookingTypes.includes(this.type);
};

transactionSchema.methods.isVTPassTransaction = function() {
  const vtpassTypes = ['airtime', 'data', 'electricity', 'tv', 'education'];
  return vtpassTypes.includes(this.type);
};

// ============================================
// STATIC METHODS
// ============================================

// Get user transactions with filters
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

// Get transaction by reference
transactionSchema.statics.getByReference = function(reference) {
  return this.findOne({ reference }).lean();
};

// Get transaction by booking reference
transactionSchema.statics.getByBookingReference = function(bookingReference) {
  return this.findOne({ bookingReference }).lean();
};

// Get transaction statistics
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
        userId: new mongoose.Types.ObjectId(userId),
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
        successCount: {
          $sum: { 
            $cond: [
              { $or: [
                { $eq: ['$status', 'success'] },
                { $eq: ['$status', 'completed'] }
              ]}, 
              1, 
              0
            ] 
          },
        },
        failedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
        },
      },
    },
  ]);
};

// Create VTPass transaction
transactionSchema.statics.createVTPassTransaction = function(data) {
  const {
    userId,
    serviceID,
    phoneNumber,
    amount,
    reference,
    type,
    billersCode,
    variation_code,
    subscription_type,
    quantity,
    request_id,
  } = data;

  return this.create({
    userId,
    serviceID,
    phoneNumber,
    amount,
    reference,
    type,
    billersCode,
    variation_code,
    subscription_type,
    quantity,
    request_id,
    status: 'pending',
    paymentMethod: 'wallet',
  });
};

// Create booking transaction
transactionSchema.statics.createBookingTransaction = function(data) {
  const {
    userId,
    bookingType,
    bookingReference,
    bookingId,
    amount,
    currency,
    paymentMethod,
    metadata,
  } = data;

  const type = bookingType === 'flight' ? 'flight_booking' : 'transport_booking';
  const reference = `${type.toUpperCase()}-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

  return this.create({
    userId,
    type,
    bookingType,
    bookingReference,
    bookingId,
    amount,
    currency: currency || 'NGN',
    reference,
    status: 'completed', // ✅ Booking transactions are completed immediately
    paymentMethod: paymentMethod || 'wallet',
    metadata: metadata || {},
    paidAt: new Date(),
  });
};

// ============================================
// EXPORT WITH OVERWRITE PROTECTION
// ============================================
module.exports = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);