const axios = require("axios");
const bcrypt = require("bcryptjs"); // ✅ ADD THIS (was missing)
const Transaction = require("../models/transaction");
const User = require("../models/user");

// Axios instance for VTpass API
const vtpassApi = axios.create({
  baseURL:
    process.env.VTPASS_ENV === "sandbox"
      ? "https://sandbox.vtpass.com/api"
      : "https://api.vtpass.com/api",
  auth: {
    username: process.env.VTPASS_API_KEY,
    password: process.env.VTPASS_SECRET_KEY,
  },
});

const makePayment = async (
  req,
  res,
  { serviceID, phoneNumber, amount, billersCode, variation_code, userId }
) => {
  const reference = `ref_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  
  let newTransaction;

  try {
    newTransaction = new Transaction({
      serviceID,
      phoneNumber,
      amount,
      reference,
      status: "pending",
      billersCode,
      userId, // ✅ ADD userId to link transaction to user
    });
    await newTransaction.save();

    const payload = {
      request_id: reference,
      serviceID,
      billersCode: billersCode || phoneNumber,
      amount,
      variation_code: variation_code || "",
    };

    console.log('VTpass payload:', payload);
    const response = await vtpassApi.post("/pay", payload);
    console.log('VTpass response:', response.data);

    if (
      response.data.code === "000" ||
      response.data.response_description === "TRANSACTION SUCCESSFUL"
    ) {
      newTransaction.status = "success";
      newTransaction.transactionId = response.data.transactionId;
    } else {
      newTransaction.status = "failed";
    }
    
    newTransaction.response = response.data;
    await newTransaction.save();

    return {
      success: true,
      message: response.data.response_description || "Transaction processed",
      data: newTransaction,
    };
  } catch (error) {
    console.error('makePayment error:', error.response?.data || error.message);
    
    const transactionError = error.response?.data || {
      code: "999",
      response_description: error.message || "Internal server error",
    };

    // ✅ Check if newTransaction exists before updating
    if (newTransaction && newTransaction._id) {
      await Transaction.findByIdAndUpdate(newTransaction._id, {
        status: "failed",
        response: transactionError,
      });
    }

    throw new Error(transactionError.response_description || error.message);
  }
};


// Fetch data plan variations from VTpass
// ✅ Get Data Plans - NO AUTH REQUIRED
const getDataPlans = async (req, res) => {
  try {
    const { network } = req.query;

    console.log('📊 Data Plans Request:', { network });

    if (!network) {
      return res.status(400).json({
        success: false,
        message: "Network parameter is required",
      });
    }

    // Map network to VTpass serviceID
    const serviceMap = {
      mtn: "mtn-data",
      airtel: "airtel-data",
      glo: "glo-data",
      "9mobile": "etisalat-data",
      etisalat: "etisalat-data",
      "mtn-data": "mtn-data",
      "airtel-data": "airtel-data",
      "glo-data": "glo-data",
      "etisalat-data": "etisalat-data",
    };

    const serviceID = serviceMap[network.toLowerCase()];

    if (!serviceID) {
      return res.status(400).json({
        success: false,
        message: `Invalid network: ${network}`,
      });
    }

    console.log("🔍 Fetching from VTPass:", serviceID);

    // Fetch from VTPass
    const response = await vtpassApi.get(
      `/service-variations?serviceID=${serviceID}`,
      { timeout: 15000 }
    );

    console.log("✅ VTPass Response Status:", response.status);

    // Extract variations (VTPass API has typo: "varations" instead of "variations")
    let variations =
      response.data?.content?.varations ||
      response.data?.content?.variations ||
      [];

    console.log("📦 Raw plans count:", variations.length);

    // Filter out unwanted plans
    const filteredVariations = variations.filter(
      (v) =>
        ![
          "glo-wtf-25",
          "glo-wtf-50",
          "glo-wtf-100",
          "Glo-opera-25",
          "Glo-opera-50",
          "Glo-opera-100",
          "mtn-xtratalk-300",
        ].includes(v.variation_code)
    );

    console.log("✅ Filtered plans count:", filteredVariations.length);

    res.json({
      success: true,
      content: {
        variations: filteredVariations,
      },
      data: {
        content: {
          variations: filteredVariations,
        },
      },
    });
  } catch (error) {
    console.error("❌ Data Plans Error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message:
        error.response?.data?.response_description ||
        "Failed to fetch data plans",
      error: error.message,
    });
  }
};




/**
 * ==============================================
 * DATA BUNDLE PAYMENT CONTROLLER
 * ==============================================
 */

/**
 * Buy Data Bundle
 * Process data bundle purchase through VTPass
 */
const buyDataBundle = async (req, res) => {
  try {
    const { phoneNumber, amount, network, variation_code, pin } = req.body;

    console.log('=== DATA BUNDLE PURCHASE REQUEST ===');
    console.log('User ID:', req.user?._id);
    console.log('Phone Number:', phoneNumber);
    console.log('Network:', network);
    console.log('Variation Code:', variation_code);
    console.log('Amount:', amount);
    console.log('===================================');

    // Validate required fields
    if (!phoneNumber || !amount || !network || !variation_code || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    // Validate user authentication
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const userId = req.user.id || req.user._id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Verify transaction PIN
    if (!user.transactionPinHash) {
      return res.status(403).json({
        success: false,
        message: 'Transaction PIN not set',
      });
    }

    const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);
    if (!isMatch) {
      return res.status(403).json({
        success: false,
        message: 'Invalid Transaction PIN',
      });
    }

    // Check wallet balance (skip in sandbox mode)
    const isSandbox = process.env.VTPASS_ENV === 'sandbox';

    if (!isSandbox && user.walletBalance < Number(amount)) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance',
      });
    }

    // Map network to VTPass serviceID
    const networkMap = {
      'mtn': 'mtn-data',
      'airtel': 'airtel-data',
      'glo': 'glo-data',
      '9mobile': 'etisalat-data',
      'etisalat': 'etisalat-data',
      'mtn-data': 'mtn-data',
      'airtel-data': 'airtel-data',
      'glo-data': 'glo-data',
      'etisalat-data': 'etisalat-data',
    };

    const serviceID = networkMap[network.toLowerCase()] || `${network.toLowerCase()}-data`;

    console.log('Service ID:', serviceID);

    // Process payment through makePayment function
    const response = await makePayment(req, res, {
      serviceID,
      phoneNumber,
      amount: Number(amount),
      variation_code,
      userId: user._id,
    });

    // Deduct from wallet balance (only in production)
    if (response.success && !isSandbox) {
      user.walletBalance -= Number(amount);
      await user.save();

      console.log('✅ Wallet balance deducted');
      console.log('New Balance:', user.walletBalance);
    }

    res.json(response);
  } catch (error) {
    console.error('Buy Data Bundle Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while processing data purchase',
      error: error.message,
    });
  }
};




const verfyTransactionPin = async (req, res) => {
  try {
    const { pin } = req.body;
    const userId = req.user._id; // ✅ Use _id instead of id
    
    const user = await User.findById(userId);
    
    if (!user || !user.transactionPinHash) {
      return res.status(403).json({ 
        success: false,
        message: "Transaction PIN not set" 
      });
    }
    
    const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);
    
    if (!isMatch) {
      return res.status(403).json({ 
        success: false,
        message: "Invalid Transaction PIN" 
      });
    }
    
    res.status(200).json({ 
      success: true, 
      message: "Transaction PIN verified" 
    });
  } catch (error) {
    console.error('Verify PIN error:', error);
    res.status(500).json({ 
      success: false,
      message: "Server error", 
      error: error.message 
    });
  }
};

const verifyTransaction = async (req, res, { reference }) => {
  try {
    // ✅ First check local database
    const transaction = await Transaction.findOne({ reference });
    
    if (!transaction) {
      return {
        success: false,
        message: "Transaction not found",
      };
    }

    // ✅ Verify with VTpass API
    const response = await vtpassApi.post("/requery", {
      request_id: reference,
    });

    if (response.data.code === "000") {
      // Update transaction status from VTpass response
      transaction.status = response.data.content?.status || transaction.status;
      transaction.response = response.data;
      await transaction.save();

      return {
        success: true,
        message: "Transaction verified",
        data: {
          transaction,
          vtpassResponse: response.data,
        },
      };
    } else {
      return {
        success: false,
        message: response.data.response_description || "Verification failed",
        data: response.data,
      };
    }
  } catch (error) {
    console.error('Verify transaction error:', error);
    const transactionError = error.response?.data || {
      code: "999",
      response_description: error.message || "Internal server error",
    };
    throw new Error(transactionError.response_description || error.message);
  }
};




/**
 * ==============================================
 * ELECTRICITY PAYMENT CONTROLLER
 * ==============================================
 */

/**
 * Verify Meter Number
 * Validates meter number and returns customer information
 */
const verifyMeterNumber = async (req, res) => {
  try {
    const { meterNumber, disco, meterType } = req.body;

    console.log('=== VERIFY METER REQUEST ===');
    console.log('Meter Number:', meterNumber);
    console.log('DISCO:', disco);
    console.log('Meter Type:', meterType);
    console.log('==========================');

    // Validate required fields
    if (!meterNumber || !disco || !meterType) {
      return res.status(400).json({
        success: false,
        message: 'Meter number, DISCO, and meter type are required',
      });
    }

    // Validate meter number format (10-13 digits)
    if (!/^\d{10,13}$/.test(meterNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid meter number format. Must be 10-13 digits',
      });
    }

    // Map DISCO to VTPass serviceID
    const discoMap = {
      'ekedc': 'ekedc',
      'ikedc': 'ikeja-electric',
      'aedc': 'abuja-electric',
      'phed': 'portharcourt-electric',
      'jed': 'jos-electric',
      'ibedc': 'ibadan-electric',
      'kaedco': 'kano-electric',
      'kedco': 'kaduna-electric',
    };

    const discoId = discoMap[disco.toLowerCase()] || disco;
    const serviceID = `${discoId}-${meterType}`;

    console.log('Service ID:', serviceID);

    // Verify with VTPass API
    try {
      const response = await vtpassApi.post('/merchant-verify', {
        serviceID,
        billersCode: meterNumber,
      });

      console.log('VTPass Verification Response:', response.data);

      if (response.data.code === '000' || response.data.content) {
        return res.json({
          success: true,
          message: 'Meter verified successfully',
          data: {
            customerName: response.data.content?.Customer_Name || 
                         response.data.content?.customerName || 
                         'Customer',
            address: response.data.content?.Address || 
                    response.data.content?.address || 
                    null,
            meterNumber: response.data.content?.Meter_Number || 
                        response.data.content?.meterNumber || 
                        meterNumber,
            outstandingBalance: response.data.content?.Outstanding_Balance || 
                               response.data.content?.outstandingBalance || 
                               0,
            customerDistrict: response.data.content?.Customer_District || 
                             response.data.content?.district || 
                             null,
            accountType: meterType,
          },
        });
      } else {
        return res.status(400).json({
          success: false,
          message: response.data.response_description || 'Meter verification failed',
        });
      }
    } catch (vtpassError) {
      console.error('VTPass Verification Error:', vtpassError.response?.data);
      
      return res.status(400).json({
        success: false,
        message: vtpassError.response?.data?.response_description || 
                'Could not verify meter number. Please check and try again.',
      });
    }
  } catch (error) {
    console.error('Verify Meter Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while verifying meter',
      error: error.message,
    });
  }
};

/**
 * Pay Electricity Bill
 * Process electricity payment through VTPass
 */
const payElectricityBill = async (req, res) => {
  try {
    const { meterNumber, disco, meterType, amount, phone, pin } = req.body;

    console.log('=== ELECTRICITY PAYMENT REQUEST ===');
    console.log('User ID:', req.user?._id);
    console.log('Meter Number:', meterNumber);
    console.log('DISCO:', disco);
    console.log('Meter Type:', meterType);
    console.log('Amount:', amount);
    console.log('Phone:', phone);
    console.log('=================================');

    // Validate required fields
    if (!meterNumber || !disco || !meterType || !amount || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    // Validate user authentication
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const userId = req.user.id || req.user._id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Verify transaction PIN
    if (!user.transactionPinHash) {
      return res.status(403).json({
        success: false,
        message: 'Transaction PIN not set',
      });
    }

    const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);
    if (!isMatch) {
      return res.status(403).json({
        success: false,
        message: 'Invalid Transaction PIN',
      });
    }

    // Check wallet balance (skip in sandbox mode)
    const isSandbox = process.env.VTPASS_ENV === 'sandbox';

    if (!isSandbox && user.walletBalance < Number(amount)) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance',
      });
    }

    // Map DISCO to VTPass serviceID
    const discoMap = {
      'ekedc': 'ekedc',
      'ikedc': 'ikeja-electric',
      'aedc': 'abuja-electric',
      'phed': 'portharcourt-electric',
      'jed': 'jos-electric',
      'ibedc': 'ibadan-electric',
      'kaedco': 'kano-electric',
      'kedco': 'kaduna-electric',
    };

    const discoId = discoMap[disco.toLowerCase()] || disco;
    const serviceID = `${discoId}-${meterType}`;

    // Process payment through makePayment function
    const response = await makePayment(req, res, {
      serviceID,
      billersCode: meterNumber,
      amount: Number(amount),
      phone: phone || user.phone || user.phoneNumber,
      userId: user._id,
    });

    // Deduct from wallet balance (only in production)
    if (response.success && !isSandbox) {
      user.walletBalance -= Number(amount);
      await user.save();
    }

    res.json(response);
  } catch (error) {
    console.error('Pay Electricity Bill Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while processing payment',
      error: error.message,
    });
  }
};


module.exports = { 
  makePayment, 
  verfyTransactionPin, 
  getDataPlans, 
  verifyTransaction,
  verifyMeterNumber, 
  payElectricityBill,
  buyDataBundle
};