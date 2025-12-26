// controllers/verificationController.js
const axios = require('axios');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const Transaction = require('../models/transaction');

// Create axios instance for NIN/BVN API
const verificationApi = axios.create({
  baseURL: 'https://checkmyninbvn.com.ng/api',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.NIN_BVN_API_KEY,
  },
  timeout: 30000,
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Validate PIN and check wallet balance
 */
const validatePinAndBalance = async (userId, pin, serviceCharge) => {
  const user = await User.findById(userId).select('+transactionPinHash');
  
  if (!user) {
    throw new Error('User not found');
  }

  if (!user.transactionPinHash) {
    throw new Error('Transaction PIN not set');
  }

  const isPinValid = await bcrypt.compare(String(pin), user.transactionPinHash);
  if (!isPinValid) {
    throw new Error('Invalid transaction PIN');
  }

  if (user.walletBalance < serviceCharge) {
    throw new Error('Insufficient wallet balance');
  }

  return user;
};

/**
 * Create transaction record
 */
const createTransaction = async (userId, type, serviceID, amount, phoneNumber) => {
  const reference = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const transaction = new Transaction({
    userId,
    type,
    serviceID,
    amount,
    reference,
    status: 'pending',
    phoneNumber,
  });
  
  await transaction.save();
  return transaction;
};

/**
 * Process successful verification
 */
const processSuccessfulVerification = async (user, transaction, apiResponse, verificationType) => {
  // Deduct from wallet
  user.walletBalance -= transaction.amount;
  await user.save();

  // Update transaction
  transaction.status = 'success';
  transaction.transactionId = apiResponse.reportID;
  transaction.response = apiResponse;
  
  // Store verification data based on type
  if (verificationType === 'NIN') {
    const ninData = apiResponse.data;
    transaction.verificationData = {
      nin: ninData.nin,
      firstName: ninData.firstname,
      middleName: ninData.middlename,
      surname: ninData.surname,
      phoneNumber: ninData.telephoneno,
      dateOfBirth: ninData.birthdate,
      gender: ninData.gender,
      residenceState: ninData.residence_state,
      residenceLGA: ninData.residence_lga,
      residenceAddress: ninData.residence_address,
      photo: ninData.photo,
      reportId: apiResponse.reportID,
    };
  } else if (verificationType === 'BVN') {
    const bvnData = apiResponse.data;
    transaction.verificationData = {
      bvn: bvnData.bvn,
      firstName: bvnData.firstname,
      middleName: bvnData.middlename,
      lastName: bvnData.lastname,
      phoneNumber: bvnData.phone,
      email: bvnData.email,
      dateOfBirth: bvnData.dob,
      gender: bvnData.gender,
      stateOfOrigin: bvnData.state_of_origin,
      stateOfResidence: bvnData.state_of_residence,
      nationality: bvnData.nationality,
      photo: bvnData.photo,
      reportId: apiResponse.reportID,
    };
  }
  
  await transaction.save();
  return transaction;
};

/**
 * Format response data for NIN
 */
// controllers/verificationController.js - formatNINResponse function

const formatNINResponse = (transaction, apiResponse) => {
  // ✅ Access nested data correctly
  const ninData = apiResponse.data.data; // Note: double .data
  
  return {
    success: true,
    message: 'NIN verified successfully',
    data: {
      reference: transaction.reference,
      transactionId: transaction.transactionId,
      reportId: apiResponse.reportID,
      nin: ninData.nin,
      fullName: `${ninData.firstname} ${ninData.middlename || ''} ${ninData.surname}`.trim(),
      dateOfBirth: ninData.birthdate,
      gender: ninData.gender,
      state: ninData.residence_state,
      lga: ninData.residence_lga,
      address: ninData.residence_address,
      phoneNumber: ninData.telephoneno,
      photo: ninData.photo, // ✅ This should now work
      amount: transaction.amount,
      verifiedAt: new Date(),
    },
  };
};
/**
 * Format response data for BVN
 */
const formatBVNResponse = (transaction, apiResponse) => {

  const bvnData = apiResponse.data.data; 
  return {
    success: true,
    message: 'BVN verified successfully',
    data: {
      reference: transaction.reference,
      transactionId: transaction.transactionId,
      reportId: apiResponse.reportID,
      bvn: bvnData.bvn,
      fullName: `${bvnData.firstname} ${bvnData.middlename} ${bvnData.lastname}`,
      dateOfBirth: bvnData.dob,
      gender: bvnData.gender,
      email: bvnData.email,
      stateOfOrigin: bvnData.state_of_origin,
      stateOfResidence: bvnData.state_of_residence,
      nationality: bvnData.nationality,
      phoneNumber: bvnData.phone,
      photo: bvnData.photo,
      amount: transaction.amount,
      verifiedAt: new Date(),
    },
  };
};

// ============================================
// NIN VERIFICATION ENDPOINTS
// ============================================

/**
 * Verify NIN by Number (₦150)
 */
const verifyNIN = async (req, res) => {
  try {
    const { nin, pin } = req.body;
    const userId = req.user.id || req.user._id;

    console.log('=== NIN VERIFICATION ===');
    console.log('User ID:', userId);
    console.log('NIN:', nin);

    // Validate inputs
    if (!nin || !/^\d{11}$/.test(nin)) {
      return res.status(400).json({
        success: false,
        message: 'NIN must be exactly 11 digits',
      });
    }

    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'Transaction PIN is required',
      });
    }

    const serviceCharge = 150;

    // Validate PIN and balance
    const user = await validatePinAndBalance(userId, pin, serviceCharge);

    // Create transaction
    const transaction = await createTransaction(
      user._id,
      'nin_verification',
      'nin_verification',
      serviceCharge,
      user.phone
    );

    // Call external API
    const response = await verificationApi.post('/nin-verification', {
      nin: nin,
      consent: true,
    });

    console.log('✅ NIN API Response:', response.data);

    if (response.data.status === 'success') {
      await processSuccessfulVerification(user, transaction, response.data, 'NIN');
      return res.json(formatNINResponse(transaction, response.data));
    } else {
      transaction.status = 'failed';
      transaction.failureReason = response.data.message || 'Verification failed';
      await transaction.save();

      return res.status(400).json({
        success: false,
        message: response.data.message || 'NIN verification failed',
      });
    }
  } catch (error) {
    console.error('❌ Verify NIN Error:', error.message);
    
    if (error.response?.data) {
      return res.status(error.response.status || 400).json({
        success: false,
        message: error.response.data.message || 'NIN verification failed',
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error while verifying NIN',
    });
  }
};

/**
 * Search NIN by Phone (₦200)
 */
const searchNINByPhone = async (req, res) => {
  try {
    const { phone, pin } = req.body;
    const userId = req.user.id || req.user._id;

    console.log('=== NIN PHONE SEARCH ===');
    console.log('User ID:', userId);
    console.log('Phone:', phone);

    // Validate inputs
    if (!phone || !/^0\d{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format',
      });
    }

    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'Transaction PIN is required',
      });
    }

    const serviceCharge = 200;

    // Validate PIN and balance
    const user = await validatePinAndBalance(userId, pin, serviceCharge);

    // Create transaction
    const transaction = await createTransaction(
      user._id,
      'nin_phone_search',
      'nin_phone_search',
      serviceCharge,
      phone
    );

    // Call external API
    const response = await verificationApi.post('/nin-phone', {
      phone: phone,
      consent: true,
    });

    console.log('✅ NIN Phone Search Response:', response.data);

    if (response.data.status === 'success') {
      await processSuccessfulVerification(user, transaction, response.data, 'NIN');
      return res.json(formatNINResponse(transaction,  response.data));
    } else {
      transaction.status = 'failed';
      transaction.failureReason = response.data.message || 'Search failed';
      await transaction.save();

      return res.status(400).json({
        success: false,
        message: response.data.message || 'NIN not found',
      });
    }
  } catch (error) {
    console.error('❌ NIN Phone Search Error:', error.message);
    
    if (error.response?.data) {
      return res.status(error.response.status || 400).json({
        success: false,
        message: error.response.data.message || 'NIN search failed',
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error while searching NIN',
    });
  }
};

/**
 * Search NIN by Tracking ID (₦200)
 */
const searchNINByTracking = async (req, res) => {
  try {
    const { trackingId, pin } = req.body;
    const userId = req.user.id || req.user._id;

    if (!trackingId) {
      return res.status(400).json({
        success: false,
        message: 'Tracking ID is required',
      });
    }

    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'Transaction PIN is required',
      });
    }

    const serviceCharge = 200;
    const user = await validatePinAndBalance(userId, pin, serviceCharge);

    const transaction = await createTransaction(
      user._id,
      'nin_tracking_search',
      'nin_tracking_search',
      serviceCharge,
      user.phone
    );

    const response = await verificationApi.post('/nin-tracking', {
      tracking_id: trackingId,
      consent: true,
    });

    if (response.data.status === 'success') {
      await processSuccessfulVerification(user, transaction, response.data, 'NIN');
      return res.json(formatNINResponse(transaction,  response.data));
    } else {
      transaction.status = 'failed';
      transaction.failureReason = response.data.message || 'Search failed';
      await transaction.save();

      return res.status(400).json({
        success: false,
        message: response.data.message || 'NIN not found',
      });
    }
  } catch (error) {
    console.error('❌ NIN Tracking Search Error:', error.message);
    
    if (error.response?.data) {
      return res.status(error.response.status || 400).json({
        success: false,
        message: error.response.data.message || 'NIN search failed',
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error while searching NIN',
    });
  }
};

// ============================================
// BVN VERIFICATION ENDPOINTS
// ============================================

/**
 * Verify BVN by Number (₦100)
 */
const verifyBVN = async (req, res) => {
  try {
    const { bvn, pin } = req.body;
    const userId = req.user.id || req.user._id;

    console.log('=== BVN VERIFICATION ===');
    console.log('User ID:', userId);
    console.log('BVN:', bvn);

    // Validate inputs
    if (!bvn || !/^\d{11}$/.test(bvn)) {
      return res.status(400).json({
        success: false,
        message: 'BVN must be exactly 11 digits',
      });
    }

    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'Transaction PIN is required',
      });
    }

    const serviceCharge = 100;

    // Validate PIN and balance
    const user = await validatePinAndBalance(userId, pin, serviceCharge);

    // Create transaction
    const transaction = await createTransaction(
      user._id,
      'bvn_verification',
      'bvn_verification',
      serviceCharge,
      user.phone
    );

    // Call external API
    const response = await verificationApi.post('/bvn-verification', {
      bvn: bvn,
      consent: true,
    });

    console.log('✅ BVN API Response:', response.data);

    if (response.data.status === 'success') {
      await processSuccessfulVerification(user, transaction, response.data, 'BVN');
      return res.json(formatBVNResponse(transaction,  response.data));
    } else {
      transaction.status = 'failed';
      transaction.failureReason = response.data.message || 'Verification failed';
      await transaction.save();

      return res.status(400).json({
        success: false,
        message: response.data.message || 'BVN verification failed',
      });
    }
  } catch (error) {
    console.error('❌ Verify BVN Error:', error.message);
    
    if (error.response?.data) {
      return res.status(error.response.status || 400).json({
        success: false,
        message: error.response.data.message || 'BVN verification failed',
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error while verifying BVN',
    });
  }
};

/**
 * Search BVN by Phone (₦150)
 */
const searchBVNByPhone = async (req, res) => {
  try {
    const { phone, pin } = req.body;
    const userId = req.user.id || req.user._id;

    console.log('=== BVN PHONE SEARCH ===');
    console.log('User ID:', userId);
    console.log('Phone:', phone);

    // Validate inputs
    if (!phone || !/^0\d{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format',
      });
    }

    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'Transaction PIN is required',
      });
    }

    const serviceCharge = 150;

    // Validate PIN and balance
    const user = await validatePinAndBalance(userId, pin, serviceCharge);

    // Create transaction
    const transaction = await createTransaction(
      user._id,
      'bvn_phone_search',
      'bvn_phone_search',
      serviceCharge,
      phone
    );

    // Call external API
    const response = await verificationApi.post('/bvn-phone', {
      phone: phone,
      consent: true,
    });

    console.log('✅ BVN Phone Search Response:', response.data);

    if (response.data.status === 'success') {
      await processSuccessfulVerification(user, transaction, response.data, 'BVN');
      return res.json(formatBVNResponse(transaction,  response.data));
    } else {
      transaction.status = 'failed';
      transaction.failureReason = response.data.message || 'Search failed';
      await transaction.save();

      return res.status(400).json({
        success: false,
        message: response.data.message || 'BVN not found',
      });
    }
  } catch (error) {
    console.error('❌ BVN Phone Search Error:', error.message);
    
    if (error.response?.data) {
      return res.status(error.response.status || 400).json({
        success: false,
        message: error.response.data.message || 'BVN search failed',
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error while searching BVN',
    });
  }
};

/**
 * Check Verification Balance (Admin only)
 */
const checkBalance = async (req, res) => {
  try {
    const response = await axios.get('https://checkmyninbvn.com.ng/api/balance', {
      headers: {
        'x-api-key': process.env.NIN_BVN_API_KEY,
      },
    });

    res.json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error('❌ Check Balance Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to check balance',
    });
  }
};

module.exports = {
  verifyNIN,
  searchNINByPhone,
  searchNINByTracking,
  verifyBVN,
  searchBVNByPhone,
  checkBalance,
};