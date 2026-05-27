'use strict';

/**
 * paymentController — VTpass services only.
 *
 * Provider map for this file:
 *   vtpass — Airtime, Data, Cable TV, Electricity
 *
 * Exam PINs  → examPinController  (VTU Africa)
 * Betting    → bettingController  (VTU Africa)
 * Wallet top-up → paystackController (Kora Pay)
 *
 * Fee model: pricing calculated via pricingService before calling VTpass.
 * Wallet is debited BEFORE the VTpass call (in a MongoDB session).
 * If VTpass fails or errors, the wallet is refunded in full.
 */

const axios    = require('axios');
const bcrypt   = require('bcryptjs');
const mongoose = require('mongoose');

const crypto         = require('crypto');
const Transaction    = require('../models/transaction');
const User           = require('../models/user');
const pricingService = require('../services/pricingService');
const vtuAfricaService = require('../services/vtuAfricaService');
const {
  deductWalletBalance: _deductWallet,
  refundWalletBalance: _refundWallet,
} = require('../util/paymentHelper');

// ─── VTpass API clients ───────────────────────────────────────────────────────
const vtpassApi = axios.create({
  baseURL: process.env.VTPASS_ENV === 'sandbox'
    ? 'https://sandbox.vtpass.com/api'
    : 'https://api.vtpass.com/api',
  headers: {
    'Content-Type': 'application/json',
    'api-key':    process.env.VTPASS_API_KEY,
    'secret-key': process.env.VTPASS_SECRET_KEY,
  },
});

const vtpassApiGet = axios.create({
  baseURL: process.env.VTPASS_ENV === 'sandbox'
    ? 'https://sandbox.vtpass.com/api'
    : 'https://api.vtpass.com/api',
  headers: {
    'Content-Type': 'application/json',
    'api-key':    process.env.VTPASS_API_KEY,
    'public-key': process.env.VTPASS_PUBLIC_KEY,
  },
});

// ─── Internal helpers ─────────────────────────────────────────────────────────
const generateRequestId = () => {
  const lagos    = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const datePart = lagos.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 12);
  return `${datePart}${Math.random().toString(36).substring(2, 10)}`;
};

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

/**
 * Make a VTpass /pay call. Returns a parsed result object.
 * Does NOT touch DB or wallets — callers own transaction lifecycle.
 */
const _callVtpass = async (payload) => {
  console.log('✅ VTpass Payload:', { ...payload, amount: payload.amount });
  const response = await vtpassApi.post('/pay', payload);
  console.log('✅ VTpass Response code:', response.data?.code);

  const isSuccess =
    response.data.code === '000' &&
    (response.data.content?.transactions?.status === 'delivered' ||
     response.data.content?.transactions?.status === 'successful');

  return {
    success:       isSuccess,
    vtpassCode:    response.data.code,
    message:       response.data.response_description || 'Transaction processed',
    transactionId: response.data.content?.transactions?.transactionId || null,
    purchasedCode: response.data.content?.transactions?.purchased_code || null,
    rawResponse:   response.data,
  };
};

// ─── Airtime ──────────────────────────────────────────────────────────────────
const buyAirtime = async (req, res) => {
  try {
    const { phoneNumber, amount, network, pin } = req.body;

    if (!phoneNumber || !amount || !network || !pin) {
      return res.status(400).json({ success: false, message: 'phoneNumber, amount, network, and pin are required.' });
    }

    const user = await verifyUserAndPin(req, pin);

    const networkMap = { mtn: 'mtn', airtel: 'airtel', glo: 'glo', '9mobile': 'etisalat', etisalat: 'etisalat' };
    const serviceID  = networkMap[network.toLowerCase()] || network.toLowerCase();

    const forSomeoneElse = Boolean(
      (user.phoneNumber || user.phone) &&
      phoneNumber.replace(/\s/g, '') !== (user.phoneNumber || user.phone || '').replace(/\s/g, '')
    );

    const pricing = pricingService.getAirtimePrice({ network, amount: Number(amount), forSomeoneElse });

    if ((user.walletBalance || 0) < pricing.userPays) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Required: ₦${pricing.userPays.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
      });
    }

    const reference  = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const request_id = generateRequestId();

    // Phase 1: Create transaction + deduct wallet atomically
    const session = await mongoose.startSession();
    let txDoc;
    try {
      session.startTransaction();
      txDoc = new Transaction({
        userId: user._id, serviceID, phoneNumber, amount: pricing.userPays,
        reference, request_id, status: 'pending', type: 'airtime', paymentMethod: 'wallet',
        provider: pricing.provider, userPaid: pricing.userPays,
        providerCost: pricing.ourCost, providerFee: pricing.providerFee,
        recipientFee: pricing.recipientFee, ourMargin: pricing.ourMargin,
        marginType: pricing.marginType, forSomeoneElse,
        pricingConfigVersion: pricingService.getConfigVersion(),
      });
      await txDoc.save({ session });
      await _deductWallet(user, pricing.userPays, session);
      await session.commitTransaction();
    } catch (dbErr) {
      await session.abortTransaction();
      console.error('[paymentController] buyAirtime DB phase failed:', dbErr.message);
      return res.status(500).json({ success: false, message: 'Could not initiate transaction. Please try again.' });
    } finally {
      session.endSession();
    }

    // Phase 2: Call VTpass
    let result;
    try {
      result = await _callVtpass({ request_id, serviceID, amount: String(amount), phone: phoneNumber });
    } catch (vtpassErr) {
      console.error('[paymentController] VTpass airtime error after debit:', vtpassErr.message);
      txDoc.status = 'failed'; txDoc.failureReason = vtpassErr.message;
      await txDoc.save();
      try { await _refundWallet(user, pricing.userPays); } catch (e) {
        console.error('[paymentController] CRITICAL: airtime refund failed:', { reference, amount: pricing.userPays, error: e.message });
      }
      return res.status(502).json({ success: false, message: 'Service provider is unavailable. Your wallet has been refunded.' });
    }

    if (!result.success) {
      txDoc.status = 'failed'; txDoc.failureReason = result.message; txDoc.response = result.rawResponse;
      await txDoc.save();
      try { await _refundWallet(user, pricing.userPays); } catch (e) {
        console.error('[paymentController] CRITICAL: airtime refund failed:', { reference, amount: pricing.userPays, error: e.message });
      }
      return res.status(400).json({ success: false, message: result.message || 'Airtime purchase failed. Your wallet has been refunded.' });
    }

    txDoc.status = 'success'; txDoc.transactionId = result.transactionId; txDoc.response = result.rawResponse;
    await txDoc.save();

    return res.json({
      success:   true,
      message:   `₦${Number(amount).toLocaleString()} airtime sent to ${phoneNumber}.`,
      reference,
      data:      txDoc,
    });

  } catch (error) {
    console.error('[paymentController] buyAirtime error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error while processing airtime purchase.' });
  }
};

// ─── Data ─────────────────────────────────────────────────────────────────────
const getDataPlans = async (req, res) => {
  try {
    const { network } = req.query;
    if (!network) return res.status(400).json({ success: false, message: 'Network parameter is required.' });

    const serviceMap = {
      mtn: 'mtn-data', airtel: 'airtel-data', glo: 'glo-data',
      '9mobile': 'etisalat-data', etisalat: 'etisalat-data',
      'mtn-data': 'mtn-data', 'airtel-data': 'airtel-data',
      'glo-data': 'glo-data', 'etisalat-data': 'etisalat-data',
    };
    const serviceID = serviceMap[network.toLowerCase()];
    if (!serviceID) return res.status(400).json({ success: false, message: `Invalid network: ${network}` });

    const response   = await vtpassApiGet.get(`/service-variations?serviceID=${serviceID}`, { timeout: 15000 });
    let variations   = response.data?.content?.varations || response.data?.content?.variations || [];
    variations       = variations.filter(v => !['glo-wtf-25','glo-wtf-50','glo-wtf-100','Glo-opera-25','Glo-opera-50','Glo-opera-100','mtn-xtratalk-300'].includes(v.variation_code));

    const catalogData = pricingService.getCatalog().data;
    const plans = variations.map(v => {
      const vtpassCost = parseFloat(v.variation_amount || 0);
      const rawMargin  = Math.round(vtpassCost * parseFloat(catalogData.markup));
      const margin     = Math.max(rawMargin, catalogData.minMargin);
      return { ...v, variation_amount: vtpassCost, userPays: vtpassCost + margin, convenienceFee: margin };
    });

    res.json({ success: true, content: { variations: plans }, data: { content: { variations: plans } } });
  } catch (error) {
    console.error('[paymentController] getDataPlans error:', error.message);
    res.status(500).json({ success: false, message: error.response?.data?.response_description || 'Failed to fetch data plans.' });
  }
};

const buyDataBundle = async (req, res) => {
  try {
    const { phoneNumber, amount, network, variation_code, pin } = req.body;

    if (!phoneNumber || !amount || !network || !variation_code || !pin) {
      return res.status(400).json({ success: false, message: 'phoneNumber, amount, network, variation_code, and pin are required.' });
    }

    const user = await verifyUserAndPin(req, pin);

    const networkMap = { mtn: 'mtn-data', airtel: 'airtel-data', glo: 'glo-data', '9mobile': 'etisalat-data', etisalat: 'etisalat-data' };
    const serviceID  = networkMap[network.toLowerCase()] || `${network.toLowerCase()}-data`;

    const forSomeoneElse = Boolean(
      (user.phoneNumber || user.phone) &&
      phoneNumber.replace(/\s/g, '') !== (user.phoneNumber || user.phone || '').replace(/\s/g, '')
    );

    const pricing = pricingService.getDataPrice({ vtpassCost: Number(amount), forSomeoneElse });

    if ((user.walletBalance || 0) < pricing.userPays) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Required: ₦${pricing.userPays.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
      });
    }

    const reference  = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const request_id = generateRequestId();

    const session = await mongoose.startSession();
    let txDoc;
    try {
      session.startTransaction();
      txDoc = new Transaction({
        userId: user._id, serviceID, phoneNumber, billersCode: phoneNumber,
        variation_code, amount: pricing.userPays, reference, request_id,
        status: 'pending', type: 'data', paymentMethod: 'wallet',
        provider: pricing.provider, userPaid: pricing.userPays,
        providerCost: pricing.ourCost, providerFee: pricing.providerFee,
        recipientFee: pricing.recipientFee, ourMargin: pricing.ourMargin,
        marginType: pricing.marginType, forSomeoneElse,
        pricingConfigVersion: pricingService.getConfigVersion(),
      });
      await txDoc.save({ session });
      await _deductWallet(user, pricing.userPays, session);
      await session.commitTransaction();
    } catch (dbErr) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: 'Could not initiate transaction. Please try again.' });
    } finally {
      session.endSession();
    }

    let result;
    try {
      result = await _callVtpass({ request_id, serviceID, billersCode: phoneNumber, variation_code, amount: String(amount), phone: phoneNumber });
    } catch (vtpassErr) {
      txDoc.status = 'failed'; txDoc.failureReason = vtpassErr.message; await txDoc.save();
      try { await _refundWallet(user, pricing.userPays); } catch (e) {
        console.error('[paymentController] CRITICAL: data refund failed:', { reference, error: e.message });
      }
      return res.status(502).json({ success: false, message: 'Service provider is unavailable. Your wallet has been refunded.' });
    }

    if (!result.success) {
      txDoc.status = 'failed'; txDoc.failureReason = result.message; txDoc.response = result.rawResponse; await txDoc.save();
      try { await _refundWallet(user, pricing.userPays); } catch (e) {
        console.error('[paymentController] CRITICAL: data refund failed:', { reference, error: e.message });
      }
      return res.status(400).json({ success: false, message: result.message || 'Data purchase failed. Your wallet has been refunded.' });
    }

    txDoc.status = 'success'; txDoc.transactionId = result.transactionId; txDoc.response = result.rawResponse;
    await txDoc.save();
    return res.json({ success: true, message: 'Data bundle purchased successfully.', reference, data: txDoc });

  } catch (error) {
    console.error('[paymentController] buyDataBundle error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error while processing data purchase.' });
  }
};

// ─── PIN verification standalone endpoint ─────────────────────────────────────
const verfyTransactionPin = async (req, res) => {
  try {
    const { pin }  = req.body;
    const userId   = req.user._id || req.user.id;
    const user     = await User.findById(userId).select('+transactionPinHash');
    if (!user?.transactionPinHash) return res.status(403).json({ success: false, message: 'Transaction PIN not set' });
    const isMatch  = await bcrypt.compare(String(pin), user.transactionPinHash);
    if (!isMatch)  return res.status(403).json({ success: false, message: 'Invalid Transaction PIN' });
    res.status(200).json({ success: true, message: 'Transaction PIN verified' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

// ─── Electricity ──────────────────────────────────────────────────────────────
const DISCO_MAP = {
  ikedc: 'ikeja-electric', ekedc: 'eko-electric', kedco: 'kano-electric',
  phed: 'portharcourt-electric', jed: 'jos-electric', ibedc: 'ibadan-electric',
  kaedco: 'kaduna-electric', aedc: 'abuja-electric', eedc: 'enugu-electric',
  bedc: 'benin-electric', aba: 'aba-electric', yedc: 'yola-electric',
};

const verifyMeterNumber = async (req, res) => {
  try {
    const { meterNumber, disco, meterType } = req.body;
    if (!meterNumber || !disco || !meterType) {
      return res.status(400).json({ success: false, message: 'meterNumber, disco, and meterType are required.' });
    }
    if (!/^\d{10,13}$/.test(meterNumber)) {
      return res.status(400).json({ success: false, message: 'Invalid meter number format. Must be 10-13 digits.' });
    }

    const serviceID = DISCO_MAP[disco.toLowerCase()] || disco;
    const response  = await vtpassApi.post('/merchant-verify', { serviceID, billersCode: meterNumber });

    if (response.data.code === '000' || response.data.content?.Customer_Name) {
      return res.json({
        success: true,
        message: 'Meter verified successfully',
        data: {
          customerName:       response.data.content?.Customer_Name || 'Customer',
          address:            response.data.content?.Address || null,
          meterNumber:        response.data.content?.Meter_Number || meterNumber,
          outstandingBalance: response.data.content?.Outstanding_Balance || 0,
          customerDistrict:   response.data.content?.Customer_District || null,
          accountType:        meterType,
        },
      });
    }
    return res.status(400).json({ success: false, message: response.data.response_description || 'Meter verification failed.' });
  } catch (error) {
    console.error('[paymentController] verifyMeterNumber error:', error.message);
    res.status(error.response ? 400 : 500).json({
      success: false,
      message: error.response?.data?.response_description || 'Could not verify meter. Please try again.',
    });
  }
};

const payElectricityBill = async (req, res) => {
  try {
    const { meterNumber, disco, meterType, amount, phone, pin } = req.body;

    if (!meterNumber || !disco || !meterType || !amount || !pin) {
      return res.status(400).json({ success: false, message: 'meterNumber, disco, meterType, amount, and pin are required.' });
    }

    const user      = await verifyUserAndPin(req, pin);
    const serviceID = DISCO_MAP[disco.toLowerCase()] || disco;
    const pricing   = pricingService.getElectricityPrice({ vtpassCost: Number(amount) });

    if ((user.walletBalance || 0) < pricing.userPays) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Required: ₦${pricing.userPays.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
      });
    }

    const reference  = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const request_id = generateRequestId();
    const phoneNum   = phone || user.phone || user.phoneNumber;

    const session = await mongoose.startSession();
    let txDoc;
    try {
      session.startTransaction();
      txDoc = new Transaction({
        userId: user._id, serviceID, phoneNumber: phoneNum, billersCode: meterNumber,
        variation_code: meterType, amount: pricing.userPays, reference, request_id,
        status: 'pending', type: 'electricity', paymentMethod: 'wallet',
        provider: pricing.provider, userPaid: pricing.userPays,
        providerCost: pricing.ourCost, providerFee: pricing.providerFee,
        recipientFee: pricing.recipientFee, ourMargin: pricing.ourMargin,
        marginType: pricing.marginType, forSomeoneElse: pricing.forSomeoneElse,
        pricingConfigVersion: pricingService.getConfigVersion(),
      });
      await txDoc.save({ session });
      await _deductWallet(user, pricing.userPays, session);
      await session.commitTransaction();
    } catch (dbErr) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: 'Could not initiate transaction. Please try again.' });
    } finally {
      session.endSession();
    }

    let result;
    try {
      result = await _callVtpass({ request_id, serviceID, billersCode: meterNumber, variation_code: meterType, amount: String(amount), phone: phoneNum });
    } catch (vtpassErr) {
      txDoc.status = 'failed'; txDoc.failureReason = vtpassErr.message; await txDoc.save();
      try { await _refundWallet(user, pricing.userPays); } catch (e) {
        console.error('[paymentController] CRITICAL: electricity refund failed:', { reference, error: e.message });
      }
      return res.status(502).json({ success: false, message: 'Service provider is unavailable. Your wallet has been refunded.' });
    }

    if (!result.success) {
      txDoc.status = 'failed'; txDoc.failureReason = result.message; txDoc.response = result.rawResponse; await txDoc.save();
      try { await _refundWallet(user, pricing.userPays); } catch (e) {
        console.error('[paymentController] CRITICAL: electricity refund failed:', { reference, error: e.message });
      }
      return res.status(400).json({ success: false, message: result.message || 'Payment failed. Your wallet has been refunded.' });
    }

    txDoc.status = 'success'; txDoc.transactionId = result.transactionId; txDoc.response = result.rawResponse;
    await txDoc.save();
    return res.json({ success: true, message: 'Electricity payment successful.', reference, data: txDoc });

  } catch (error) {
    console.error('[paymentController] payElectricityBill error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error while processing payment.' });
  }
};

// ─── Cable TV ─────────────────────────────────────────────────────────────────
const TV_PROVIDER_MAP = { dstv: 'dstv', gotv: 'gotv', startimes: 'startimes', showmax: 'showmax' };

const getTVBouquets = async (req, res) => {
  try {
    const { provider } = req.query;
    if (!provider) return res.status(400).json({ success: false, message: 'TV provider is required.' });

    const serviceID = TV_PROVIDER_MAP[provider.toLowerCase()];
    if (!serviceID) return res.status(400).json({ success: false, message: `Invalid TV provider: ${provider}` });

    const response  = await vtpassApiGet.get(`/service-variations?serviceID=${serviceID}`, { timeout: 15000 });
    let variations  = response.data?.content?.varations || response.data?.content?.variations || [];
    variations      = variations.filter(v => parseFloat(v.variation_amount || 0) >= 1000);

    const bouquets = variations.map(v => {
      const vtpassCost = parseFloat(v.variation_amount || 0);
      const pricing    = pricingService.getCablePrice({ vtpassCost });
      return { ...v, variation_amount: vtpassCost, userPays: pricing.userPays, convenienceFee: pricing.ourMargin };
    });

    res.json({ success: true, message: 'TV bouquets fetched successfully', data: { provider, bouquets } });
  } catch (error) {
    console.error('[paymentController] getTVBouquets error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch TV bouquets.' });
  }
};

const verifySmartcard = async (req, res) => {
  try {
    const { smartcardNumber, provider } = req.body;
    if (!smartcardNumber || !provider) return res.status(400).json({ success: false, message: 'Smartcard number and provider are required.' });
    if (!/^\d{10,11}$/.test(smartcardNumber)) return res.status(400).json({ success: false, message: 'Invalid smartcard number format.' });

    const serviceID = TV_PROVIDER_MAP[provider.toLowerCase()];
    if (!serviceID) return res.status(400).json({ success: false, message: `Invalid TV provider: ${provider}` });

    const response = await vtpassApi.post('/merchant-verify', { serviceID, billersCode: smartcardNumber });

    const hasError    = response.data.content?.error || response.data.content?.Error;
    const hasCustomer = response.data.content?.Customer_Name || response.data.content?.customerName;

    if (hasError)    return res.status(400).json({ success: false, message: hasError || 'Invalid smartcard number.' });
    if (!hasCustomer) return res.status(400).json({ success: false, message: 'Invalid smartcard number or no customer data found.' });

    return res.json({
      success: true,
      message: 'Smartcard verified successfully',
      data: {
        customerName:       response.data.content?.Customer_Name || 'Customer',
        smartcardNumber:    response.data.content?.Customer_Number || smartcardNumber,
        currentBouquet:     response.data.content?.Current_Bouquet || null,
        currentBouquetCode: response.data.content?.Current_Bouquet_Code || null,
        renewalAmount:      response.data.content?.Renewal_Amount || null,
        dueDate:            response.data.content?.Due_Date || null,
        status:             response.data.content?.Status || 'Active',
      },
    });
  } catch (error) {
    console.error('[paymentController] verifySmartcard error:', error.message);
    res.status(error.response ? 400 : 500).json({
      success: false,
      message: error.response?.data?.response_description || 'Could not verify smartcard. Please try again.',
    });
  }
};

// Shared logic for subscribe (change) and renew TV subscriptions
const _subscribeTVHelper = async (req, res, subscriptionType) => {
  try {
    const { smartcardNumber, provider, variation_code, amount, phone, pin } = req.body;

    if (!smartcardNumber || !provider || !amount || !pin) {
      return res.status(400).json({ success: false, message: 'smartcardNumber, provider, amount, and pin are required.' });
    }
    if (subscriptionType === 'change' && !variation_code) {
      return res.status(400).json({ success: false, message: 'variation_code is required for bouquet change.' });
    }

    const user      = await verifyUserAndPin(req, pin);
    const serviceID = TV_PROVIDER_MAP[provider.toLowerCase()];
    if (!serviceID) return res.status(400).json({ success: false, message: `Invalid TV provider: ${provider}` });

    const pricing = pricingService.getCablePrice({ vtpassCost: Number(amount) });

    if ((user.walletBalance || 0) < pricing.userPays) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Required: ₦${pricing.userPays.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
      });
    }

    const reference  = `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const request_id = generateRequestId();
    const phoneNum   = phone || user.phone || user.phoneNumber;

    const session = await mongoose.startSession();
    let txDoc;
    try {
      session.startTransaction();
      txDoc = new Transaction({
        userId: user._id, serviceID, phoneNumber: phoneNum, billersCode: smartcardNumber,
        variation_code, subscription_type: subscriptionType, amount: pricing.userPays,
        reference, request_id, status: 'pending', type: 'tv', paymentMethod: 'wallet',
        provider: pricing.provider, userPaid: pricing.userPays,
        providerCost: pricing.ourCost, providerFee: pricing.providerFee,
        recipientFee: pricing.recipientFee, ourMargin: pricing.ourMargin,
        marginType: pricing.marginType, forSomeoneElse: pricing.forSomeoneElse,
        pricingConfigVersion: pricingService.getConfigVersion(),
      });
      await txDoc.save({ session });
      await _deductWallet(user, pricing.userPays, session);
      await session.commitTransaction();
    } catch (dbErr) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: 'Could not initiate transaction. Please try again.' });
    } finally {
      session.endSession();
    }

    let result;
    try {
      const payload = {
        request_id, serviceID, billersCode: smartcardNumber,
        amount: String(amount), phone: phoneNum, subscription_type: subscriptionType,
      };
      if (variation_code) payload.variation_code = variation_code;
      result = await _callVtpass(payload);
    } catch (vtpassErr) {
      txDoc.status = 'failed'; txDoc.failureReason = vtpassErr.message; await txDoc.save();
      try { await _refundWallet(user, pricing.userPays); } catch (e) {
        console.error('[paymentController] CRITICAL: TV refund failed:', { reference, error: e.message });
      }
      return res.status(502).json({ success: false, message: 'Service provider is unavailable. Your wallet has been refunded.' });
    }

    if (!result.success) {
      txDoc.status = 'failed'; txDoc.failureReason = result.message; txDoc.response = result.rawResponse; await txDoc.save();
      try { await _refundWallet(user, pricing.userPays); } catch (e) {
        console.error('[paymentController] CRITICAL: TV refund failed:', { reference, error: e.message });
      }
      return res.status(400).json({ success: false, message: result.message || 'TV subscription failed. Your wallet has been refunded.' });
    }

    if (result.purchasedCode) txDoc.purchasedCode = result.purchasedCode;
    txDoc.status = 'success'; txDoc.transactionId = result.transactionId; txDoc.response = result.rawResponse;
    await txDoc.save();
    return res.json({ success: true, message: 'TV subscription successful.', reference, data: txDoc });

  } catch (error) {
    console.error('[paymentController] TV subscription error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error while processing TV subscription.' });
  }
};

const subscribeTVBouquet  = (req, res) => _subscribeTVHelper(req, res, 'change');
const renewTVSubscription = (req, res) => _subscribeTVHelper(req, res, 'renew');

// ─── Transaction history & stats ──────────────────────────────────────────────
const getTransactionByReference = async (req, res) => {
  try {
    const { reference } = req.params;
    const userId        = req.user?.id || req.user?._id;
    const transaction   = await Transaction.findOne({ reference, userId });
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found.' });
    res.json({ success: true, data: transaction });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch transaction.', error: error.message });
  }
};

const getTransactionHistory = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { category, status, startDate, endDate, page = 1, limit = 20 } = req.query;

    const query = { userId };
    if (category && category !== 'all') query.type   = category;
    if (status && status !== 'all')     query.status = status;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [transactions, totalCount, stats] = await Promise.all([
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Transaction.countDocuments(query),
      Transaction.aggregate([
        { $match: query },
        { $group: {
          _id: null,
          totalAmount:  { $sum: '$amount' },
          successCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          failedCount:  { $sum: { $cond: [{ $eq: ['$status', 'failed']  }, 1, 0] } },
          pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        }},
      ]),
    ]);

    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          currentPage: parseInt(page),
          totalPages:  Math.ceil(totalCount / parseInt(limit)),
          totalCount,
          hasMore:     parseInt(page) < Math.ceil(totalCount / parseInt(limit)),
        },
        stats: stats[0] || { totalAmount: 0, successCount: 0, failedCount: 0, pendingCount: 0 },
      },
    });
  } catch (error) {
    console.error('[paymentController] getTransactionHistory error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transaction history.', error: error.message });
  }
};

const getTransactionStats = async (req, res) => {
  try {
    const userId     = req.user?.id || req.user?._id;
    const { period = 'month' } = req.query;

    const now = new Date();
    let startDate;
    switch (period) {
      case 'day':  startDate = new Date(now.setHours(0, 0, 0, 0)); break;
      case 'week': startDate = new Date(now.setDate(now.getDate() - 7)); break;
      case 'year': startDate = new Date(now.setFullYear(now.getFullYear() - 1)); break;
      default:     startDate = new Date(now.setMonth(now.getMonth() - 1));
    }

    const stats = await Transaction.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId), createdAt: { $gte: startDate } } },
      { $group: {
        _id:          '$type',
        count:        { $sum: 1 },
        totalAmount:  { $sum: '$amount' },
        successCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
      }},
    ]);

    res.json({ success: true, data: { period, stats } });
  } catch (error) {
    console.error('[paymentController] getTransactionStats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transaction statistics.', error: error.message });
  }
};

// ─── Airtime2Cash ─────────────────────────────────────────────────────────────

const verifyAirtimeToCash = async (req, res) => {
  try {
    const { network } = req.body;
    const result = await vtuAfricaService.verifyAirtime2Cash({ network });

    // transferPhone is the only hard requirement — ok (code===101) may differ per sandbox vs live
    if (!result.transferPhone) {
      console.warn(`[verifyAirtimeToCash] No transferPhone returned for ${network}. code=${result.code} raw=`, JSON.stringify(result.raw));
      return res.status(503).json({
        success: false,
        message: `${network.toUpperCase()} Airtime to Cash is currently unavailable. Please try again later.`,
      });
    }

    const pricing = pricingService.getAirtime2CashRate({ network, amount: 1000 });

    return res.json({
      success:       true,
      transferPhone: result.transferPhone,
      network:       result.network || network,
      deductionRate: pricing.deductionRate,
      message:       result.message,
    });
  } catch (err) {
    console.error('[verifyAirtimeToCash] error:', err.message);
    return res.status(502).json({ success: false, message: 'Service verification failed. Please try again.' });
  }
};

const convertAirtimeToCash = async (req, res) => {
  try {
    const { network, senderNumber, amount, sitePhone, pin } = req.body;

    // Verify PIN
    const user = await User.findById(req.user.id).select('+transactionPinHash +walletBalance');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const pinMatch = await require('bcryptjs').compare(pin, user.transactionPinHash || '');
    if (!pinMatch) return res.status(401).json({ success: false, message: 'Incorrect transaction PIN.' });

    const numAmount = parseFloat(amount);
    const pricing   = pricingService.getAirtime2CashRate({ network, amount: numAmount });
    const ref       = `payflex-a2c-${crypto.randomUUID()}`;

    // Create pending transaction (no wallet deduction — this is a credit flow)
    const txDoc = await Transaction.create({
      userId:        req.user.id,
      reference:     ref,
      type:          'airtime_conversion',
      network:       network.toLowerCase(),
      phoneNumber:   senderNumber,
      amount:        pricing.userReceives,
      status:        'pending',
      paymentMethod: 'airtime',
      description:   `${network.toUpperCase()} Airtime2Cash — ₦${numAmount.toLocaleString()} submitted`,
      metadata: {
        submittedAmount: numAmount,
        deductionRate:   pricing.deductionRate,
        ourMargin:       pricing.ourMargin,
        sitePhone:       sitePhone || null,
      },
    });

    // Call VTU Africa
    let vtuResult;
    try {
      vtuResult = await vtuAfricaService.convertAirtime({
        network,
        sender:       user.email,
        sendernumber: senderNumber,
        amount:       numAmount,
        sitephone:    sitePhone || undefined,
        ref,
        webhookURL:   process.env.VTUAFRICA_WEBHOOK_URL || '',
      });
    } catch (networkErr) {
      console.error('[convertAirtimeToCash] VTU Africa network error:', networkErr.message);
      txDoc.status = 'pending';
      await txDoc.save();
      return res.status(202).json({
        success: true,
        pending: true,
        message: 'Your conversion request has been submitted. Your wallet will be credited once VTU Africa confirms receipt of your airtime.',
        data:    { ref, transactionId: txDoc._id },
      });
    }

    if (!vtuResult.ok) {
      txDoc.status = 'failed';
      await txDoc.save();
      return res.status(400).json({ success: false, message: vtuResult.description?.message || 'Conversion request rejected. Please try again.' });
    }

    txDoc.status = 'pending';
    txDoc.metadata = { ...txDoc.metadata, vtuReferenceId: vtuResult.referenceId };
    await txDoc.save();

    return res.json({
      success: true,
      pending: true,
      message: 'Conversion request submitted successfully. Your wallet will be credited once we receive your airtime.',
      data: {
        ref,
        transactionId:   txDoc._id,
        submittedAmount: numAmount,
        expectedPayout:  pricing.userReceives,
        deductionRate:   pricing.deductionRate,
      },
    });
  } catch (err) {
    console.error('[convertAirtimeToCash] error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

const handleAirtimeToCashWebhook = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { ref, status, credit, message } = req.body;
    if (!ref) return res.status(400).json({ code: 400, message: 'Reference missing' });

    const transaction = await Transaction.findOne({ reference: ref });
    if (!transaction) return res.status(404).json({ code: 404, message: 'Transaction not found' });

    // Idempotency — already processed
    if (transaction.status === 'success') {
      return res.json({ code: 101, status: 'Completed', message: 'Already processed' });
    }

    if (status === 'Completed') {
      const creditAmount = parseFloat(credit) || transaction.amount;

      session.startTransaction();
      const user = await User.findById(transaction.userId).select('+walletBalance').session(session);
      if (user) {
        user.walletBalance = (user.walletBalance || 0) + creditAmount;
        await user.save({ session });
      }
      transaction.status = 'success';
      transaction.amount = creditAmount;
      transaction.response = req.body;
      await transaction.save({ session });
      await session.commitTransaction();
    } else {
      transaction.status        = 'failed';
      transaction.failureReason = message || 'Conversion failed';
      transaction.response      = req.body;
      await transaction.save();
    }

    return res.json({ code: 101, status: 'Completed', message: 'Webhook processed' });
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    console.error('[handleAirtimeToCashWebhook] error:', error.message);
    return res.status(500).json({ code: 500, message: 'Webhook processing failed' });
  } finally {
    session.endSession();
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  buyAirtime,
  verfyTransactionPin,
  getDataPlans,
  buyDataBundle,
  verifyMeterNumber,
  payElectricityBill,
  getTVBouquets,
  verifySmartcard,
  subscribeTVBouquet,
  renewTVSubscription,
  verifyAirtimeToCash,
  convertAirtimeToCash,
  handleAirtimeToCashWebhook,
  getTransactionByReference,
  getTransactionHistory,
  getTransactionStats,
};
