const axios = require("axios");
const bcrypt = require("bcryptjs");
const Transaction = require("../models/transaction");
const User = require("../models/user");

// ✅ FIXED: VTPass uses custom headers, not Basic Auth
const vtpassApi = axios.create({
  baseURL:
    process.env.VTPASS_ENV === "sandbox"
      ? "https://sandbox.vtpass.com/api"
      : "https://api.vtpass.com/api",
  headers: {
    'Content-Type': 'application/json',
    'api-key': process.env.VTPASS_API_KEY,
    'secret-key': process.env.VTPASS_SECRET_KEY,  // ✅ For POST requests
  },
});

// ✅ For GET requests, we need to use public-key instead
const vtpassApiGet = axios.create({
  baseURL:
    process.env.VTPASS_ENV === "sandbox"
      ? "https://sandbox.vtpass.com/api"
      : "https://api.vtpass.com/api",
  headers: {
    'Content-Type': 'application/json',
    'api-key': process.env.VTPASS_API_KEY,
    'public-key': process.env.VTPASS_PUBLIC_KEY,  //For GET requests
  },
});

// Generate proper VTpass request_id
const generateRequestId = () => {
  const now = new Date();
  const lagosTime = new Date(now.toLocaleString("en-US", { 
    timeZone: "Africa/Lagos" 
  }));
  
  const datePart = lagosTime.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .slice(0, 12);
  
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `${datePart}${randomPart}`;
};

// Helper function to verify user and pin
const verifyUserAndPin = async (req, pin) => {
  const userId = req.user?.id || req.user?._id;
  if (!userId) throw new Error('Authentication required');

  const user = await User.findById(userId).select('+transactionPinHash');
  if (!user) throw new Error('User not found');

  if (!user.transactionPinHash) throw new Error('Transaction PIN not set');

  const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);
  if (!isMatch) throw new Error('Invalid Transaction PIN');

  return user;
};

// Helper function to validate wallet balance
const validateWalletBalance = (user, amount) => {
  if (user.walletBalance < Number(amount)) {
    throw new Error('Insufficient wallet balance');
  }
};

// Helper function to deduct wallet balance
const deductWalletBalance = async (user, amount) => {
  user.walletBalance -= Number(amount);
  await user.save();
  return user.walletBalance;
};

/**
 * Universal Payment Handler for VTPass Services
 * Handles: Airtime, Data, Electricity, TV Subscription, Education
 * 
 * @param {Object} params - Payment parameters
 * @param {string} params.serviceID - VTPass service ID
 * @param {string} params.phoneNumber - Customer phone number
 * @param {number} params.amount - Payment amount
 * @param {string} params.billersCode - Biller's code (meter number, smartcard number, etc.)
 * @param {string} params.variation_code - Service variation code
 * @param {string} params.subscription_type - TV subscription type (change/renew)
 * @param {number} params.quantity - Quantity for certain services
 * @param {string} params.userId - User ID
 * @param {string} params.request_id - Optional request ID
 */
const makePayment = async (
  req,
  res,
  { 
    serviceID, 
    phoneNumber, 
    amount, 
    billersCode, 
    variation_code, 
    subscription_type,
    quantity,
    userId, 
    request_id 
  }
) => {
  const finalRequestId = request_id || generateRequestId();
  
  const reference = `ref_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  
  let newTransaction;

  try {
    // Determine transaction type based on serviceID
    const getTransactionType = (serviceID) => {
      if (serviceID.includes('-data')) return 'data';
      if (serviceID.includes('-electric')) return 'electricity';
      if (serviceID.includes('dstv') || serviceID.includes('gotv') || 
          serviceID.includes('startimes') || serviceID.includes('showmax')) return 'tv';
      if (serviceID.includes('waec') || serviceID.includes('neco') || 
          serviceID.includes('jamb')) return 'education';
      return 'airtime';
    };

    const transactionType = getTransactionType(serviceID);

    // Create transaction record
    newTransaction = new Transaction({
      serviceID,
      phoneNumber,
      amount,
      reference,
      request_id: finalRequestId,
      status: "pending",
      billersCode,
      variation_code,
      subscription_type,
      quantity,
      userId,
      type: transactionType,
    });
    await newTransaction.save();

    // Build payload based on service type
    let payload;

    switch (transactionType) {
      case 'data':
        // Data bundle payload
        payload = {
          request_id: finalRequestId,
          serviceID,
          billersCode: billersCode || phoneNumber,
          variation_code: variation_code || "",
          amount: amount.toString(),
          phone: phoneNumber,
        };
        break;

      case 'electricity':
        // Electricity payment payload
        payload = {
          request_id: finalRequestId,
          serviceID,
          billersCode, // Meter number
          variation_code: variation_code || "prepaid", // prepaid/postpaid
          amount: amount.toString(),
          phone: phoneNumber,
        };
        break;

      case 'tv':
        // TV subscription payload
        payload = {
          request_id: finalRequestId,
          serviceID,
          billersCode, // Smartcard/IUC number
          variation_code, // Bouquet code
          amount: amount.toString(),
          phone: phoneNumber,
          subscription_type: subscription_type || "renew", // change/renew
        };
        
        // Add quantity if provided (for multi-month subscriptions)
        if (quantity) {
          payload.quantity = quantity;
        }
        break;

      case 'education':
        // Educational services payload (WAEC, NECO, JAMB)
        payload = {
          request_id: finalRequestId,
          serviceID,
          billersCode, // Registration number or candidate ID
          variation_code, // Exam type/package
          amount: amount.toString(),
          phone: phoneNumber,
        };
        break;

      case 'airtime':
      default:
        // Airtime recharge payload (simplest)
        payload = {
          request_id: finalRequestId,
          serviceID,
          amount: amount.toString(),
          phone: phoneNumber,
        };
        break;
    }

    console.log(`✅ VTpass ${transactionType.toUpperCase()} Payload:`, payload);
    
    // Make payment request to VTpass
    const response = await vtpassApi.post("/pay", payload);
    console.log('✅ VTpass Response:', response.data);

    // Check for successful transaction
    const isSuccess = 
      response.data.code === "000" && 
      (response.data.content?.transactions?.status === "delivered" ||
       response.data.content?.transactions?.status === "successful");

    if (isSuccess) {
      newTransaction.status = "success";
      newTransaction.transactionId = response.data.content?.transactions?.transactionId || 
                                   response.data.transactionId;
      
      // Store additional info for specific service types
      if (transactionType === 'tv' && response.data.content?.transactions?.purchased_code) {
        newTransaction.purchasedCode = response.data.content.transactions.purchased_code;
      }
      
      console.log('✅ Transaction successful:', newTransaction.transactionId);
    } else {
      newTransaction.status = "failed";
      newTransaction.failureReason = response.data.response_description || 'Transaction failed';
      console.log('❌ Transaction failed:', newTransaction.failureReason);
    }
    
    newTransaction.response = response.data;
    await newTransaction.save();

    return {
      success: newTransaction.status === "success",
      message: response.data.response_description || "Transaction processed",
      data: newTransaction,
      vtpassCode: response.data.code,
      transactionType,
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
 */
const buyAirtime = async (req, res) => {
  try {
    const { phoneNumber, amount, network, pin } = req.body;

    console.log('=== AIRTIME PURCHASE REQUEST ===');
    console.log('User ID:', req.user?._id);
    console.log('Phone Number:', phoneNumber);
    console.log('Network:', network);
    console.log('Amount:', amount);
    console.log('================================');

    if (!phoneNumber || !amount || !network || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phoneNumber, amount, network, pin',
      });
    }

    // Validate PIN + user
    const user = await verifyUserAndPin(req, pin);

    // Validate wallet
    validateWalletBalance(user, amount);

    // Map VTpass network codes
    const networkMap = {
      mtn: 'mtn',
      airtel: 'airtel',
      glo: 'glo',
      '9mobile': 'etisalat',
      etisalat: 'etisalat',
    };

    const serviceID = networkMap[network.toLowerCase()] || network.toLowerCase();

    const request_id = generateRequestId();

    // ❗ FIXED PAYLOAD — VTpass airtime requires "phone"
    const payload = {
      request_id,
      serviceID,
      amount: String(amount),
      phone: phoneNumber,          // VTpass field
      phoneNumber: phoneNumber,    // Transaction model field
    };

    console.log('✅ VTpass Airtime Payload (Corrected):', payload);

    // Shared payment function
    const response = await makePayment(req, res, {
      ...payload,
      userId: user._id,
    });

    // Deduct wallet on success
    if (response.success) {
      await deductWalletBalance(user, amount);
      console.log('✅ Wallet balance deducted');
    }

    // Respond to client
    res.json({
      ...response,
      reference: response.data?.reference || request_id,
    });

  } catch (error) {
    console.error('❌ Buy Airtime Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error while processing airtime purchase',
    });
  }
};




/**
 * Get Data Plans - Uses GET request
 */
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

    // ✅ Use vtpassApiGet for GET requests (has public-key)
    const response = await vtpassApiGet.get(
      `/service-variations?serviceID=${serviceID}`,
      { timeout: 15000 }
    );

    console.log("✅ VTPass Response Status:", response.status);

    let variations =
      response.data?.content?.varations ||
      response.data?.content?.variations ||
      [];

    console.log("📦 Raw plans count:", variations.length);

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
 */
const buyDataBundle = async (req, res) => {
  try {
    const { phoneNumber, amount, network, variation_code, pin } = req.body;

    console.log('=== DATA PURCHASE REQUEST ===');
    console.log('Phone Number:', phoneNumber);
    console.log('Network:', network);
    console.log('Amount:', amount);
    console.log('Variation Code:', variation_code);
    console.log('============================');

    if (!phoneNumber || !amount || !network || !variation_code || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phoneNumber, amount, network, variation_code, pin are all required',
      });
    }

    const user = await verifyUserAndPin(req, pin);
    validateWalletBalance(user, amount);

    const networkMap = {
      mtn: 'mtn-data',
      airtel: 'airtel-data',
      glo: 'glo-data',
      '9mobile': 'etisalat-data',
      etisalat: 'etisalat-data',
    };

    const serviceID = networkMap[network.toLowerCase()] || `${network.toLowerCase()}-data`;
    const request_id = generateRequestId();
    
    const payload = {
      request_id,
      serviceID,
      billersCode: phoneNumber,
      variation_code,
      amount: Number(amount).toString(),
      phoneNumber,
    };

    console.log('✅ VTpass Data Purchase Payload:', payload);

    const response = await makePayment(req, res, {
      ...payload,
      userId: user._id || user.id,
    });

    if (response.success) {
      await deductWalletBalance(user, amount);
    }

    // ✅ Ensure reference is at top level
    res.json({
      ...response,
      reference: response.data?.reference || request_id,
    });
  } catch (error) {
    console.error('❌ Buy Data Bundle Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error while processing data purchase',
    });
  }
};

/**
 * Verify Transaction PIN
 */
const verfyTransactionPin = async (req, res) => {
  try {
    const { pin } = req.body;
    const userId = req.user._id || req.user.id;
    
    const user = await User.findById(userId).select('+transactionPinHash');
    
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

// /**
//  * Test VTPass Connection
//  */
// const testVTPassConnection = async (req, res) => {
//   try {
//     console.log('🔑 Testing VTPass credentials...');
//     console.log('API Key:', process.env.VTPASS_API_KEY);
//     console.log('Secret Key:', process.env.VTPASS_SECRET_KEY ? '✅ Set' : '❌ Missing');
//     console.log('Public Key:', process.env.VTPASS_PUBLIC_KEY ? '✅ Set' : '❌ Missing');
//     console.log('Environment:', process.env.VTPASS_ENV);
    
//     // ✅ Use vtpassApiGet for balance check (GET request)
//     const response = await vtpassApiGet.get('/balance');
    
//     console.log('✅ VTPass connection successful!');
//     console.log('Balance:', response.data);
    
//     res.json({
//       success: true,
//       message: 'VTPass credentials are valid',
//       balance: response.data,
//     });
//   } catch (error) {
//     console.error('❌ VTPass connection failed:', error.response?.data || error.message);
//     res.status(500).json({
//       success: false,
//       message: 'VTPass credentials invalid',
//       error: error.response?.data || error.message,
//     });
//   }
// };


// ==========================
// Electricity purchase logics and functionalities
// ==========================

/**
 * Verify Meter Number
 */
const verifyMeterNumber = async (req, res) => {
  try {
    const { meterNumber, disco, meterType } = req.body;

    console.log('=== VERIFY METER REQUEST ===');
    console.log('Meter Number:', meterNumber);
    console.log('DISCO:', disco);
    console.log('Meter Type:', meterType);
    console.log('==========================');

    if (!meterNumber || !disco || !meterType) {
      return res.status(400).json({
        success: false,
        message: 'Meter number, DISCO, and meter type are required',
      });
    }

    if (!/^\d{10,13}$/.test(meterNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid meter number format. Must be 10-13 digits',
      });
    }

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

    try {
      // ✅ Use vtpassApi for POST request (merchant-verify)
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

    if (!meterNumber || !disco || !meterType || !amount || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    const user = await verifyUserAndPin(req, pin);
    validateWalletBalance(user, amount);

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

    const response = await makePayment(req, res, {
      serviceID,
      billersCode: meterNumber,
      amount: Number(amount),
      phoneNumber: phone || user.phone || user.phoneNumber,
      userId: user._id,
    });

    if (response.success) {
      await deductWalletBalance(user, amount);
    }

    res.json(response);
  } catch (error) {
    console.error('Pay Electricity Bill Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error while processing payment',
    });
  }
};


// ============================================
// ALL TV SUBSCRIPTION LOGICS
// ============================================

/**
 * Get TV Bouquets/Packages
 * GET /api/payments/tv-plans
 * Returns available subscription plans for a TV provider
 */
const getTVBouquets = async (req, res) => {
  try {
    const { provider } = req.query;

    console.log('📺 TV Bouquets Request:', { provider });

    if (!provider) {
      return res.status(400).json({
        success: false,
        message: "TV provider is required",
      });
    }

    // Map provider to VTPass serviceID
    const providerMap = {
      dstv: "dstv",
      gotv: "gotv",
      startimes: "startimes",
      showmax: "showmax",
    };

    const serviceID = providerMap[provider.toLowerCase()];

    if (!serviceID) {
      return res.status(400).json({
        success: false,
        message: `Invalid TV provider: ${provider}`,
      });
    }

    console.log("🔍 Fetching from VTPass:", serviceID);

    // Use vtpassApiGet for GET requests (with public-key)
    const response = await vtpassApiGet.get(
      `/service-variations?serviceID=${serviceID}`,
      { timeout: 15000 }
    );

    console.log("✅ VTPass Response Status:", response.status);

    const variations =
      response.data?.content?.varations ||
      response.data?.content?.variations ||
      [];

    console.log("📦 Bouquets count:", variations.length);

    res.json({
      success: true,
      message: "TV bouquets fetched successfully",
      data: {
        provider,
        bouquets: variations,
      },
    });
  } catch (error) {
    console.error("❌ TV Bouquets Error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message:
        error.response?.data?.response_description ||
        "Failed to fetch TV bouquets",
      error: error.message,
    });
  }
};

/**
 * Verify Smartcard Number
 * POST /api/payments/verify-smartcard
 * Validates smartcard and returns customer info
 */
const verifySmartcard = async (req, res) => {
  try {
    const { smartcardNumber, provider } = req.body;

    console.log('=== VERIFY SMARTCARD REQUEST ===');
    console.log('Smartcard Number:', smartcardNumber);
    console.log('Provider:', provider);
    console.log('===============================');

    if (!smartcardNumber || !provider) {
      return res.status(400).json({
        success: false,
        message: 'Smartcard number and provider are required',
      });
    }

    // Validate smartcard number format (usually 10-11 digits)
    if (!/^\d{10,11}$/.test(smartcardNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid smartcard number format',
      });
    }

    // Map provider to VTPass serviceID
    const providerMap = {
      dstv: "dstv",
      gotv: "gotv",
      startimes: "startimes",
      showmax: "showmax",
    };

    const serviceID = providerMap[provider.toLowerCase()];

    if (!serviceID) {
      return res.status(400).json({
        success: false,
        message: `Invalid TV provider: ${provider}`,
      });
    }

    console.log('Service ID:', serviceID);

    try {
      // Use vtpassApi for POST request (merchant-verify)
      const response = await vtpassApi.post('/merchant-verify', {
        serviceID,
        billersCode: smartcardNumber,
      });

      console.log('VTPass Verification Response:', response.data);

      if (response.data.code === '000' || response.data.content) {
        return res.json({
          success: true,
          message: 'Smartcard verified successfully',
          data: {
            customerName: response.data.content?.Customer_Name || 
                         response.data.content?.customerName || 
                         'Customer',
            smartcardNumber: response.data.content?.Customer_Number ||
                            smartcardNumber,
            currentBouquet: response.data.content?.Current_Bouquet ||
                           response.data.content?.currentBouquet ||
                           null,
            currentBouquetCode: response.data.content?.Current_Bouquet_Code ||
                               response.data.content?.currentBouquetCode ||
                               null,
            renewalAmount: response.data.content?.Renewal_Amount ||
                          response.data.content?.renewalAmount ||
                          null,
            dueDate: response.data.content?.Due_Date ||
                    response.data.content?.dueDate ||
                    null,
            status: response.data.content?.Status ||
                   response.data.content?.status ||
                   'Active',
          },
        });
      } else {
        return res.status(400).json({
          success: false,
          message: response.data.response_description || 'Smartcard verification failed',
        });
      }
    } catch (vtpassError) {
      console.error('VTPass Verification Error:', vtpassError.response?.data);
      
      return res.status(400).json({
        success: false,
        message: vtpassError.response?.data?.response_description || 
                'Could not verify smartcard number. Please check and try again.',
      });
    }
  } catch (error) {
    console.error('Verify Smartcard Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while verifying smartcard',
      error: error.message,
    });
  }
};

/**
 * Subscribe TV (New Purchase/Change Bouquet)
 * POST /api/payments/subscribe-tv
 * Purchase new bouquet or change existing one
 */
const subscribeTVBouquet = async (req, res) => {
  try {
    const { smartcardNumber, provider, variation_code, amount, phone, pin } = req.body;

    console.log('=== TV SUBSCRIPTION REQUEST ===');
    console.log('User ID:', req.user?._id);
    console.log('Smartcard Number:', smartcardNumber);
    console.log('Provider:', provider);
    console.log('Variation Code:', variation_code);
    console.log('Amount:', amount);
    console.log('===============================');

    if (!smartcardNumber || !provider || !variation_code || !amount || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    // Verify user and PIN
    const user = await verifyUserAndPin(req, pin);

    // Check wallet balance
    validateWalletBalance(user, amount);

    // Map provider to VTPass serviceID
    const providerMap = {
      dstv: "dstv",
      gotv: "gotv",
      startimes: "startimes",
      showmax: "showmax",
    };

    const serviceID = providerMap[provider.toLowerCase()];

    if (!serviceID) {
      return res.status(400).json({
        success: false,
        message: `Invalid TV provider: ${provider}`,
      });
    }

    const request_id = generateRequestId();

    // Process payment through makePayment function
    const response = await makePayment(req, res, {
      serviceID,
      billersCode: smartcardNumber,
      variation_code,
      subscription_type: 'change', // New purchase/change bouquet
      amount: Number(amount),
      phoneNumber: phone || user.phone || user.phoneNumber,
      userId: user._id,
      request_id,
    });

    // Deduct from wallet balance after successful purchase
    if (response.success) {
      await deductWalletBalance(user, amount);
      console.log('✅ Wallet balance deducted');
    }

    res.json({
      ...response,
      reference: response.data?.reference || request_id,
    });
  } catch (error) {
    console.error('Subscribe TV Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error while processing TV subscription',
    });
  }
};

/**
 * Renew TV Subscription
 * POST /api/payments/renew-tv
 * Renew current bouquet at renewal amount
 */
const renewTVSubscription = async (req, res) => {
  try {
    const { smartcardNumber, provider, amount, phone, pin } = req.body;

    console.log('=== TV RENEWAL REQUEST ===');
    console.log('User ID:', req.user?._id);
    console.log('Smartcard Number:', smartcardNumber);
    console.log('Provider:', provider);
    console.log('Amount:', amount);
    console.log('==========================');

    if (!smartcardNumber || !provider || !amount || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    // Verify user and PIN
    const user = await verifyUserAndPin(req, pin);

    // Check wallet balance
    validateWalletBalance(user, amount);

    // Map provider to VTPass serviceID
    const providerMap = {
      dstv: "dstv",
      gotv: "gotv",
      startimes: "startimes",
      showmax: "showmax",
    };

    const serviceID = providerMap[provider.toLowerCase()];

    if (!serviceID) {
      return res.status(400).json({
        success: false,
        message: `Invalid TV provider: ${provider}`,
      });
    }

    const request_id = generateRequestId();

    // Process payment through makePayment function
    const response = await makePayment(req, res, {
      serviceID,
      billersCode: smartcardNumber,
      subscription_type: 'renew', // Renew current bouquet
      amount: Number(amount),
      phoneNumber: phone || user.phone || user.phoneNumber,
      userId: user._id,
      request_id,
    });

    // Deduct from wallet balance after successful renewal
    if (response.success) {
      await deductWalletBalance(user, amount);
      console.log('✅ Wallet balance deducted');
    }

    res.json({
      ...response,
      reference: response.data?.reference || request_id,
    });
  } catch (error) {
    console.error('Renew TV Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error while processing TV renewal',
    });
  }
};



/**
 * Get Transaction by Reference
 * GET /api/transactions/:reference
 */
const getTransactionByReference = async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user?.id || req.user?._id;
    console.log('📋 Fetching transaction:', { reference, userId });

    const transaction = await Transaction.findOne({
      reference,
      userId, // Ensure user owns the transaction
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found',
      });
    }

    res.json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    console.error('Get Transaction Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction',
      error: error.message,
    });
  }
};

/**
 * Get User Transaction History with Filters
 * GET /api/transactions/history
 */
// In paymentController.js - getTransactionHistory function

const getTransactionHistory = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { 
      category,
      status,
      startDate,
      endDate,
      page = 1,
      limit = 20 
    } = req.query;

    console.log('📋 Fetching transaction history:', { 
      userId: userId.toString(), // ✅ Log as string
      category, 
      status, 
      startDate, 
      endDate,
    });

    // Build query
    const query = { 
      userId: userId // ✅ MongoDB will handle ObjectId conversion
    };

    // Filter by category (service type)
    if (category && category !== 'all') {
      query.type = category;
    }

    // Filter by status
    if (status && status !== 'all') {
      query.status = status;
    }

    // Filter by date range
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const endDateTime = new Date(endDate);
        endDateTime.setHours(23, 59, 59, 999);
        query.createdAt.$lte = endDateTime;
      }
    }

    console.log('🔍 Query:', JSON.stringify(query, null, 2)); // ✅ Debug query

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Execute query
    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    console.log(`✅ Found ${transactions.length} transactions`); // ✅ Check count

    // Get total count
    const totalCount = await Transaction.countDocuments(query);
    const totalPages = Math.ceil(totalCount / parseInt(limit));

    // Calculate summary statistics
    const stats = await Transaction.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          successCount: {
            $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] },
          },
          failedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
          },
          pendingCount: {
            $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] },
          },
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalCount,
          hasMore: parseInt(page) < totalPages,
        },
        stats: stats[0] || {
          totalAmount: 0,
          successCount: 0,
          failedCount: 0,
          pendingCount: 0,
        },
      },
    });
  } catch (error) {
    console.error('❌ Get Transaction History Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction history',
      error: error.message,
    });
  }
};
/**
 * Get Transaction Statistics
 * GET /api/transactions/stats
 */
const getTransactionStats = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { period = 'month' } = req.query; // day, week, month, year

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

    
    const stats = await Transaction.aggregate([
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
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        period,
        stats,
      },
    });
  } catch (error) {
    console.error('❌ Get Transaction Stats Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction statistics',
      error: error.message,
    });
  }
};



// ============================================
// GENERAL EXPORT 
// ============================================

module.exports = { 
  // AIRTIME EXPORT
  buyAirtime, 

  // PIN VERIFICATION EXPORT
  verfyTransactionPin,
  
  // DATA EXPORT
  getDataPlans, 
  buyDataBundle,

  // ELECTRICTY EXPORT
  verifyMeterNumber, 
  payElectricityBill,

  // TEST FUNCTION EXPORT
  // testVTPassConnection,

  // TV EXPORT
  getTVBouquets,
  verifySmartcard,
  subscribeTVBouquet,
  renewTVSubscription,

  // transaction reference
  getTransactionByReference,

  getTransactionHistory,
  getTransactionStats,
};