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
  headers: {
    'Content-Type': 'application/json',
  },
  auth: {
    username: process.env.VTPASS_API_KEY,
    password: process.env.VTPASS_SECRET_KEY,
  },
});

// ✅ Generate proper VTpass request_id according to their format
const generateRequestId = () => {
  const now = new Date();
  
  // Convert to Africa/Lagos timezone (GMT+1)
  const lagosTime = new Date(now.toLocaleString("en-US", { 
    timeZone: "Africa/Lagos" 
  }));
  
  // Format: YYYYMMDDHHII (12 numeric characters)
  const datePart = lagosTime.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .slice(0, 12); // YYYYMMDDHHII
  
  // Add random alphanumeric characters to make it unique
  const randomPart = Math.random().toString(36).substring(2, 10);
  
  return `${datePart}${randomPart}`;
};

// helper function to verify user and pin
const verifyUserAndPin = async (req, pin) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) throw new Error('Authentication required');

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  if (!user.transactionPinHash) throw new Error('Transaction PIN not set');

  const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);
  if (!isMatch) throw new Error('Invalid Transaction PIN');

  return user;
};

// helper function to validate wallet balance
const validateWalletBalance = (user, amount) => {
  if (user.walletBalance < Number(amount)) {
    throw new Error('Insufficient wallet balance');
  }
};

// helper function to deduct wallet balance
const deductWalletBalance = async (user, amount) => {
  user.walletBalance -= Number(amount);
  await user.save();
  return user.walletBalance;
};

const makePayment = async (
  req,
  res,
  { serviceID, phoneNumber, amount, billersCode, variation_code, userId, request_id }
) => {
  // ✅ Use provided request_id or generate new one
  const finalRequestId = request_id || generateRequestId();
  
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
      request_id: finalRequestId,
      status: "pending",
      billersCode,
      variation_code,
      userId,
      type: 'data', // ✅ Add transaction type
    });
    await newTransaction.save();

    // ✅ Dynamic payload based on service type
    const isDataService = serviceID.includes('-data');
    
    const payload = isDataService 
      ? {
          // ✅ Data service payload
          request_id: finalRequestId,
          serviceID,
          billersCode: billersCode || phoneNumber, // Required for data
          variation_code: variation_code || "", // Required for data
          amount: amount.toString(),
          phone: phoneNumber,
        }
      : {
          // ✅ Airtime service payload
          request_id: finalRequestId,
          serviceID,
          amount: amount.toString(),
          phone: phoneNumber,
          variation_code: variation_code || "", // Optional for airtime
        };

    console.log('✅ VTpass Payload:', payload);
    
    const response = await vtpassApi.post("/pay", payload);
    console.log('✅ VTpass Response:', response.data);

    // ✅ Check for successful transaction
    if (
      response.data.code === "000" ||
      response.data.response_description === "TRANSACTION SUCCESSFUL" ||
      response.data.content?.transactions?.status === "delivered"
    ) {
      newTransaction.status = "success";
      newTransaction.transactionId = response.data.content?.transactions?.transactionId || 
                                   response.data.transactionId;
    } else {
      newTransaction.status = "failed";
      newTransaction.failureReason = response.data.response_description;
    }
    
    newTransaction.response = response.data;
    await newTransaction.save();

    return {
      success: newTransaction.status === "success",
      message: response.data.response_description || "Transaction processed",
      data: newTransaction,
    };
  } catch (error) {
    console.error('❌ makePayment error:', error.response?.data || error.message);
    
    const transactionError = error.response?.data || {
      code: "999",
      response_description: error.message || "Internal server error",
    };

    if (newTransaction && newTransaction._id) {
      await Transaction.findByIdAndUpdate(newTransaction._id, {
        status: "failed",
        response: transactionError,
        failureReason: transactionError.response_description,
      });
    }

    throw new Error(transactionError.response_description || error.message);
  }
};



/**
 * Buy Airtime
 * Handles airtime purchase through VTPass with reusable helpers
 */
const buyAirtime = async (req, res) => {
  try {
    const { phoneNumber, amount, pin } = req.body;

    console.log('=== AIRTIME PURCHASE REQUEST ===');
    console.log('User ID:', req.user?._id);
    console.log('Phone Number:', phoneNumber);
    console.log('Amount:', amount);
    console.log('================================');

    // Validate required fields
    if (!phoneNumber || !amount || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phoneNumber, amount, network, pin are all required',
      });
    }

    // 1️⃣ Verify user and transaction PIN
    const user = await verifyUserAndPin(req, pin);

    // 2️⃣ Check wallet balance
    validateWalletBalance(user, amount);

    // 3️⃣ Map network to VTPass serviceID
    const networkMap = {
      'mtn': 'mtn',
      'airtel': 'airtel',
      'glo': 'glo',
      '9mobile': 'etisalat',
      'etisalat': 'etisalat',
    };

    const serviceID = networkMap[network.toLowerCase()] || network.toLowerCase();

    // 4️⃣ Create request ID and payload
    const request_id = generateRequestId();

    const payload = {
      request_id,
      serviceID,
      billersCode: phoneNumber, // For airtime, billersCode is the recipient number
      amount: Number(amount).toString(),
      phone: phoneNumber,
    };

    console.log('✅ VTpass Airtime Payload:', payload);

    // 5️⃣ Make payment via VTpass
    const response = await makePayment(req, res, {
      ...payload,
      userId: user._id || user.id,
    });
    console.log('VTpass API Response:', response.data);


    // 6️⃣ Deduct from wallet after successful purchase
    if (response.success) {
      await deductWalletBalance(user, amount);
      console.log('✅ Wallet balance deducted');
    }

    // 7️⃣ Return response to frontend
    res.json(response);

  } catch (error) {
    console.error('❌ Buy Airtime Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error while processing airtime purchase',
    });
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
 * Buy Data Bundle
 * Process data bundle purchase through VTPass
 */
const buyDataBundle = async (req, res) => {
  try {
    const { phoneNumber, amount, variation_code, pin } = req.body;

    if (!phoneNumber || !amount || !variation_code || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phoneNumber, amount, network, variation_code, pin are all required',
      });
    }

    // 1️⃣ Verify user and PIN
    const user = await verifyUserAndPin(req, pin);

    // 2️⃣ Check wallet balance
    validateWalletBalance(user, amount);

    // 3️⃣ Map service ID
    const networkMap = {
      mtn: 'mtn-data',
      airtel: 'airtel-data',
      glo: 'glo-data',
      '9mobile': 'etisalat-data',
      etisalat: 'etisalat-data',
    };

    const serviceID = networkMap[network.toLowerCase()] || `${network.toLowerCase()}-data`;

    // 4️⃣ Prepare payload
    const request_id = generateRequestId();
    const payload = {
      request_id,
      serviceID,
      billersCode: phoneNumber,
      variation_code,
      amount: Number(amount).toString(),
      phone: phoneNumber,
    };

    console.log('✅ VTpass Data Purchase Payload:', payload);

    // 5️⃣ Make payment via VTpass
    const response = await makePayment(req, res, {
      ...payload,
      userId: user._id || user.id,
    });

    // 6️⃣ Deduct wallet after successful transaction
    if (response.success) {
      await deductWalletBalance(user, amount);
    }

    res.json(response);
  } catch (error) {
    console.error('❌ Buy Data Bundle Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error while processing data purchase',
    });
  }
};


const verfyTransactionPin = async (req, res) => {
  try {
    const { pin } = req.body;
    const userId = req.user._id || user.id; // ✅ Use _id instead of id
    
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
      'ikedc': 'ikeja-electric',
      'ekedc': 'eko-electric',
      'kedco': 'kano-electric',
      'phed': 'portharcourt-electric',
      'jed': 'jos-electric',
      'ibedc': 'ibadan-electric',
      'kaedco': 'kaduna-electric',
      'aedc': 'abuja-electric',
      'eedc': 'enugu-electric',
      'bedc': 'benin-electric',
      'aba': 'aba-electric',
      'yedc': 'yola-electric',
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

    if (user.walletBalance < Number(amount)) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance',
      });
    }

    // Map DISCO to VTPass serviceID
    const discoMap = {
      'ikedc': 'ikeja-electric',
      'ekedc': 'eko-electric',
      'kedco': 'kano-electric',
      'phed': 'portharcourt-electric',
      'jed': 'jos-electric',
      'ibedc': 'ibadan-electric',
      'kaedco': 'kaduna-electric',
      'aedc': 'abuja-electric',
      'eedc': 'enugu-electric',
      'bedc': 'benin-electric',
      'aba': 'aba-electric',
      'yedc': 'yola-electric',
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
  buyAirtime, 
  verfyTransactionPin, 
  getDataPlans, 
  // verifyTransaction,
  verifyMeterNumber, 
  payElectricityBill,
  buyDataBundle
};