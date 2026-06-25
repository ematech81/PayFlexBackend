// utils/paymentHelper.js

const bcrypt = require('bcryptjs');
const User = require('../models/user');
const Transaction = require('../models/transaction');
const mongoose = require('mongoose');

// ============================================
// USER & PIN VERIFICATION
// ============================================

/**
 * Verify user authentication and transaction PIN
 * @param {Object} req - Express request object
 * @param {string} pin - Transaction PIN to verify
 * @returns {Promise<Object>} User object with transactionPinHash
 * @throws {Error} If user not found or PIN invalid
 */
const verifyUserAndPin = async (req, pin) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) {
    throw new Error('Authentication required');
  }

  const user = await User.findById(userId).select('+transactionPinHash +walletBalance');
  if (!user) {
    throw new Error('User not found');
  }

  if (!user.transactionPinHash) {
    throw new Error('Transaction PIN not set. Please set up your PIN in settings');
  }

  const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);
  if (!isMatch) {
    throw new Error('Invalid Transaction PIN');
  }

  return user;
};

// ============================================
// WALLET OPERATIONS
// ============================================

/**
 * Validate if user has sufficient wallet balance
 * @param {Object} user - User object
 * @param {number} amount - Amount to validate
 * @throws {Error} If insufficient balance
 */
const validateWalletBalance = (user, amount) => {
  const balance = user.walletBalance || 0;
  const requiredAmount = Number(amount);

  if (balance < requiredAmount) {
    throw new Error(
      `Insufficient wallet balance. Available: ₦${balance.toLocaleString()}, Required: ₦${requiredAmount.toLocaleString()}`
    );
  }
};

/**
 * Atomically deduct amount from user's wallet balance using $inc.
 * The { walletBalance: { $gte: amount } } condition makes the balance check
 * and the deduction a single atomic DB operation — concurrent requests cannot
 * both succeed if the combined deduction would exceed the actual balance.
 */
const deductWalletBalance = async (user, amount, session = null) => {
  const n = Number(amount);
  const opts = { new: true, select: '+walletBalance' };
  if (session) opts.session = session;

  const updated = await User.findOneAndUpdate(
    { _id: user._id, walletBalance: { $gte: n } },
    { $inc: { walletBalance: -n } },
    opts
  );

  if (!updated) {
    throw new Error(
      `Insufficient wallet balance. Required: ₦${n.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}`
    );
  }

  user.walletBalance = updated.walletBalance; // keep in-memory object in sync
  console.log(`✅ Wallet deducted: ₦${n} | New balance: ₦${user.walletBalance}`);
  return user.walletBalance;
};

/**
 * Atomically refund amount to user's wallet balance using $inc.
 * No condition needed for credits — always safe to add.
 */
const refundWalletBalance = async (user, amount, session = null) => {
  const n = Number(amount);
  const opts = { new: true, select: '+walletBalance' };
  if (session) opts.session = session;

  const updated = await User.findOneAndUpdate(
    { _id: user._id },
    { $inc: { walletBalance: n } },
    opts
  );

  if (!updated) throw new Error('User not found during wallet refund');

  user.walletBalance = updated.walletBalance;
  console.log(`✅ Wallet refunded: ₦${n} | New balance: ₦${user.walletBalance}`);
  return user.walletBalance;
};

// ============================================
// TRANSACTION HANDLING WITH ROLLBACK
// ============================================

/**
 * Process payment with automatic rollback on failure
 * Supports both VTPass services and bookings (transport/flight)
 * 
 * @param {Object} params - Payment parameters
 * @param {Object} params.user - User object (from verifyUserAndPin)
 * @param {number} params.amount - Payment amount
 * @param {string} params.type - Transaction type (airtime, data, transport_booking, flight_booking, etc.)
 * @param {Function} params.paymentOperation - Async function that performs the actual payment/booking
 * @param {Object} params.transactionData - Additional data for Transaction model
 * @param {boolean} params.useMongoTransaction - Whether to use MongoDB transactions (default: false)
 * @returns {Promise<Object>} { success, transaction, response, newBalance }
 */
const processPaymentWithRollback = async ({
  user,
  amount,
  type,
  paymentOperation,
  transactionData = {},
  useMongoTransaction = false,
}) => {
  let session = null;
  let walletDeducted = false;
  let transaction = null;

  try {
    // Start MongoDB transaction if requested
    if (useMongoTransaction) {
      session = await mongoose.startSession();
      session.startTransaction();
    }

    // 1. Validate wallet balance
    validateWalletBalance(user, amount);

    // 2. Create pending transaction record
    transaction = new Transaction({
      userId: user._id,
      amount: Number(amount),
      type,
      status: 'pending',
      ...transactionData,
    });

    if (session) {
      await transaction.save({ session });
    } else {
      await transaction.save();
    }

    console.log(`📝 Transaction created: ${transaction.reference || transaction._id}`);

    // 3. Deduct wallet
    const newBalance = await deductWalletBalance(user, amount, session);
    walletDeducted = true;

    // 4. Perform the actual payment/booking operation
    const operationResult = await paymentOperation(transaction, session);

    // 5. Update transaction based on result
    if (operationResult.success) {
      transaction.status = operationResult.status || 'success';
      transaction.transactionId = operationResult.transactionId || transaction.reference;
      transaction.response = operationResult.response;
      
      if (session) {
        await transaction.save({ session });
        await session.commitTransaction();
      } else {
        await transaction.save();
      }

      console.log(`✅ Payment successful: ${transaction.transactionId}`);

      return {
        success: true,
        transaction,
        response: operationResult.response,
        newBalance,
      };
    } else {
      // Operation failed - trigger rollback
      throw new Error(operationResult.message || 'Payment operation failed');
    }

  } catch (error) {
    console.error('❌ Payment error:', error.message);

    // Rollback: Refund wallet if it was deducted
    if (walletDeducted && user) {
      try {
        if (session) {
          await session.abortTransaction();
          console.log('🔄 MongoDB transaction aborted - wallet automatically rolled back');
        } else {
          await refundWalletBalance(user, amount);
          console.log('🔄 Manual wallet rollback completed');
        }
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      }
    } else if (session) {
      await session.abortTransaction();
    }

    // Update transaction as failed
    if (transaction && transaction._id) {
      try {
        await Transaction.findByIdAndUpdate(transaction._id, {
          status: 'failed',
          failureReason: error.message,
          response: error.response?.data || { error: error.message },
        });
      } catch (updateError) {
        console.error('❌ Failed to update transaction:', updateError);
      }
    }

    throw error;

  } finally {
    if (session) {
      session.endSession();
    }
  }
};

// ============================================
// SPECIALIZED PAYMENT PROCESSORS
// ============================================

/**
 * Process VTPass payment (airtime, data, electricity, TV, education)
 * @param {Object} params - VTPass payment parameters
 * @returns {Promise<Object>} Payment result
 */
const processVTPassPayment = async ({
  user,
  amount,
  type,
  serviceID,
  phoneNumber,
  billersCode,
  variation_code,
  subscription_type,
  quantity,
  request_id,
  vtpassApi, // Pass the API instance
}) => {
  const reference = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const finalRequestId = request_id || `req_${Date.now()}`;

  return await processPaymentWithRollback({
    user,
    amount,
    type,
    transactionData: {
      serviceID,
      phoneNumber,
      reference,
      request_id: finalRequestId,
      billersCode,
      variation_code,
      subscription_type,
      quantity,
    },
    paymentOperation: async (transaction) => {
      // Build VTPass payload
      let payload = {
        request_id: finalRequestId,
        serviceID,
        amount: amount.toString(),
        phone: phoneNumber,
      };

      // Add service-specific fields
      if (billersCode) payload.billersCode = billersCode;
      if (variation_code) payload.variation_code = variation_code;
      if (subscription_type) payload.subscription_type = subscription_type;
      if (quantity) payload.quantity = quantity;

      console.log('📤 VTPass payload:', payload);

      // Call VTPass API
      const response = await vtpassApi.post('/pay', payload);
      
      const isSuccess = 
        response.data.code === '000' && 
        (response.data.content?.transactions?.status === 'delivered' ||
         response.data.content?.transactions?.status === 'successful');

      return {
        success: isSuccess,
        status: isSuccess ? 'success' : 'failed',
        transactionId: response.data.content?.transactions?.transactionId,
        response: response.data,
        message: response.data.response_description,
      };
    },
    useMongoTransaction: false, // VTPass doesn't need MongoDB transactions
  });
};

/**
 * Process transport booking payment
 * @param {Object} params - Transport booking parameters
 * @returns {Promise<Object>} Booking result
 */
const processTransportBooking = async ({
  user,
  amount,
  tripDetails,
  passengers,
  bookingService, // Pass the booking service
}) => {
  const bookingReference = `TRV-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

  return await processPaymentWithRollback({
    user,
    amount,
    type: 'transport_booking',
    transactionData: {
      reference: bookingReference,
      bookingReference,
    },
    paymentOperation: async (transaction, session) => {
      // Create booking
      const booking = await bookingService.createBooking({
        userId: user._id,
        bookingReference,
        tripDetails,
        passengers,
        amount,
        session,
      });

      return {
        success: true,
        status: 'completed',
        transactionId: bookingReference,
        response: { bookingId: booking._id, bookingReference },
      };
    },
    useMongoTransaction: true, // Use MongoDB transactions for safety
  });
};

/**
 * Process flight booking payment (with Amadeus integration)
 * @param {Object} params - Flight booking parameters
 * @returns {Promise<Object>} Booking result
 */
const processFlightBooking = async ({
  user,
  amount,
  flightData,
  travelers,
  contacts,
  flightService, // Pass the flight service
}) => {
  const bookingReference = `FL-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

  return await processPaymentWithRollback({
    user,
    amount,
    type: 'flight_booking',
    transactionData: {
      reference: bookingReference,
      bookingReference,
      bookingType: 'flight',
    },
    paymentOperation: async (transaction, session) => {
      // Call Amadeus Flight Create Orders
      const amadeusBooking = await flightService.createFlightOrder({
        flightOffers: flightData.flightOffers,
        travelers,
        contacts,
      });

      // Create local booking record
      const booking = await flightService.saveBooking({
        userId: user._id,
        bookingReference,
        amadeusOrderId: amadeusBooking.data.id,
        flightData,
        travelers,
        amount,
        session,
      });

      return {
        success: true,
        status: 'completed',
        transactionId: bookingReference,
        response: { 
          bookingId: booking._id, 
          bookingReference,
          amadeusOrderId: amadeusBooking.data.id,
        },
      };
    },
    useMongoTransaction: true, // Use MongoDB transactions for safety
  });
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Core utilities
  verifyUserAndPin,
  validateWalletBalance,
  deductWalletBalance,
  refundWalletBalance,
  
  // Payment processors
  processPaymentWithRollback,
  processVTPassPayment,
  processTransportBooking,
  processFlightBooking,
};