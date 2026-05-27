'use strict';

/**
 * Kora Pay wallet top-up controller
 * Routes (unchanged): /api/payment/*
 *
 * Flow:
 *   1. POST /initialize  → create pending Transaction, get checkout_url from Kora
 *   2. User pays on Kora checkout page
 *   3. Kora fires webhook → POST /webhook  → credit wallet atomically
 *   4. Frontend polls  GET /verify/:ref    → confirm status + get new balance
 */

const axios    = require('axios');
const crypto   = require('crypto');
const mongoose = require('mongoose');
const Transaction = require('../models/transaction');
const User        = require('../models/user');

const KORA_BASE = 'https://api.korapay.com/merchant/api/v1';

const koraApi = axios.create({
  baseURL: KORA_BASE,
  headers: { 'Content-Type': 'application/json' },
});

const _authHeader = () => ({
  Authorization: `Bearer ${process.env.KORA_SECRET_KEY}`,
});

// ─── Initialize ───────────────────────────────────────────────────────────────
exports.initializePayment = async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user._id || req.user.id;

    if (!amount || Number(amount) < 100) {
      return res.status(400).json({ success: false, message: 'Minimum top-up amount is ₦100.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.email) {
      return res.status(400).json({ success: false, message: 'An email address is required to process card payments. Please add one to your profile.' });
    }

    const reference = `PF_TOPUP_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const amountNaira = Number(amount);

    // Create pending transaction BEFORE calling Kora — so we never lose a payment
    await Transaction.create({
      userId: user._id,
      type: 'wallet_topup',
      amount: amountNaira,
      reference,
      status: 'pending',
      paymentMethod: 'card',
      metadata: { koraRef: reference },
    });

    const koraRes = await koraApi.post('/charges/initialize', {
      amount: amountNaira,
      currency: 'NGN',
      reference,
      notification_url: `${process.env.BASE_URL}/api/payment/webhook`,
      redirect_url:     process.env.KORA_REDIRECT_URL || `${process.env.BASE_URL}/payment/complete`,
      customer: {
        name:  `${user.firstName} ${user.lastName}`.trim(),
        email: user.email,
      },
    }, { headers: _authHeader() });

    if (!koraRes.data?.status) {
      return res.status(502).json({ success: false, message: koraRes.data?.message || 'Failed to initialize payment with Kora.' });
    }

    return res.json({
      success: true,
      data: {
        reference,
        checkout_url: koraRes.data.data.checkout_url,
      },
    });
  } catch (err) {
    console.error('[koraPayController] initializePayment error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to initialize payment.' });
  }
};

// ─── Verify (frontend polls this after the user pays) ─────────────────────────
exports.verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;

    const transaction = await Transaction.findOne({ reference, type: 'wallet_topup' });
    if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found.' });

    // Already credited — return current balance
    if (transaction.status === 'success') {
      const user = await User.findById(transaction.userId);
      return res.json({
        success: true,
        status: 'success',
        message: 'Payment already processed.',
        data: { amount: transaction.amount, newBalance: user?.walletBalance ?? 0 },
      });
    }

    // Query Kora for authoritative status
    const koraRes = await koraApi.get(`/charges/${reference}`, { headers: _authHeader() });
    const charge  = koraRes.data?.data;

    if (!charge) {
      return res.status(502).json({ success: false, message: 'Could not fetch charge status from Kora.' });
    }

    if (charge.status === 'success') {
      const amountPaid = Number(charge.amount); // Kora sends naira, not kobo
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const user = await User.findById(transaction.userId).select('+walletBalance').session(session);
        if (!user) { await session.abortTransaction(); throw new Error('User not found'); }

        user.walletBalance = (user.walletBalance || 0) + amountPaid;
        await user.save({ session });

        transaction.status   = 'success';
        transaction.amount   = amountPaid;
        transaction.response = charge;
        transaction.paidAt   = new Date();
        await transaction.save({ session });
        await session.commitTransaction();

        console.log(`[koraPayController] Wallet credited ₦${amountPaid} for user ${user._id} ref ${reference}`);

        return res.json({
          success: true,
          status: 'success',
          message: `₦${amountPaid.toLocaleString()} added to your wallet.`,
          data: { amount: amountPaid, newBalance: user.walletBalance, reference },
        });
      } catch (err) {
        await session.abortTransaction().catch(() => {});
        throw err;
      } finally {
        session.endSession();
      }
    }

    // Still pending or failed
    if (charge.status === 'failed') {
      transaction.status = 'failed';
      await transaction.save();
    }

    return res.json({ success: true, status: charge.status, message: 'Payment not yet completed.' });
  } catch (err) {
    console.error('[koraPayController] verifyPayment error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to verify payment.' });
  }
};

// ─── Webhook (Kora fires this when payment completes) ─────────────────────────
exports.handleWebhook = async (req, res) => {
  // Always 200 — Kora retries on non-2xx
  res.status(200).json({ received: true });

  try {
    // req.body is a raw Buffer (express.raw applied in server.js)
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const bodyStr = rawBody.toString('utf8');

    // Verify HMAC-SHA256 signature
    const signature = req.headers['x-korapay-signature'];
    const expected  = crypto
      .createHmac('sha256', process.env.KORA_SECRET_KEY || '')
      .update(rawBody)
      .digest('hex');

    if (!signature || signature !== expected) {
      console.warn('[koraPayWebhook] Invalid signature — ignoring.');
      return;
    }

    let payload;
    try { payload = JSON.parse(bodyStr); } catch {
      console.warn('[koraPayWebhook] Could not parse body.');
      return;
    }

    if (payload.event !== 'charge.success') return;

    const { reference, amount, status } = payload.data || {};
    if (status !== 'success' || !reference) return;

    // Idempotency: skip if already processed
    const transaction = await Transaction.findOne({ reference, type: 'wallet_topup' });
    if (!transaction || transaction.status !== 'pending') {
      console.log(`[koraPayWebhook] Ref ${reference} already processed or not found — skipping.`);
      return;
    }

    const amountPaid = Number(amount); // Kora sends naira
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const user = await User.findById(transaction.userId).select('+walletBalance').session(session);
      if (!user) { await session.abortTransaction(); return; }

      user.walletBalance = (user.walletBalance || 0) + amountPaid;
      await user.save({ session });

      transaction.status   = 'success';
      transaction.amount   = amountPaid;
      transaction.response = payload.data;
      transaction.paidAt   = new Date();
      await transaction.save({ session });
      await session.commitTransaction();

      console.log(`[koraPayWebhook] Wallet credited ₦${amountPaid} for user ${user._id} ref ${reference}`);
    } catch (err) {
      await session.abortTransaction().catch(() => {});
      console.error('[koraPayWebhook] Error crediting wallet:', err.message);
    } finally {
      session.endSession();
    }
  } catch (err) {
    console.error('[koraPayWebhook] Unhandled error:', err.message);
  }
};

// ─── Payment history ──────────────────────────────────────────────────────────
exports.getPaymentHistory = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const [transactions, total] = await Promise.all([
      Transaction.find({ userId, type: 'wallet_topup' })
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit))
        .select('-response')
        .lean(),
      Transaction.countDocuments({ userId, type: 'wallet_topup' }),
    ]);

    return res.json({ success: true, data: { transactions, total, page: parseInt(page) } });
  } catch (err) {
    console.error('[koraPayController] getPaymentHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch payment history.' });
  }
};
