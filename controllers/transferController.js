'use strict';

const crypto      = require('crypto');
const mongoose    = require('mongoose');
const Transaction = require('../models/transaction');
const User        = require('../models/user');
const koraTransfer = require('../services/koraTransferService');
const { deductWalletBalance, refundWalletBalance } = require('../util/paymentHelper');

const MIN_TRANSFER   = 500;
const DAILY_LIMIT    = 200_000;

// Static Nigerian bank list — used as fallback when KoraPay bank API is unavailable
const NIGERIAN_BANKS = [
  { name: 'Access Bank',                    code: '044' },
  { name: 'Citibank Nigeria',               code: '023' },
  { name: 'Ecobank Nigeria',                code: '050' },
  { name: 'Fidelity Bank',                  code: '070' },
  { name: 'First Bank of Nigeria',          code: '011' },
  { name: 'First City Monument Bank (FCMB)',code: '214' },
  { name: 'Globus Bank',                    code: '103' },
  { name: 'Guaranty Trust Bank (GTBank)',   code: '058' },
  { name: 'Heritage Bank',                  code: '030' },
  { name: 'Keystone Bank',                  code: '082' },
  { name: 'Kuda Bank',                      code: '090267' },
  { name: 'Moniepoint Microfinance Bank',   code: '090405' },
  { name: 'Opay (OPay Digital Services)',   code: '100004' },
  { name: 'PalmPay',                        code: '100033' },
  { name: 'Polaris Bank',                   code: '076' },
  { name: 'Providus Bank',                  code: '101' },
  { name: 'Stanbic IBTC Bank',              code: '221' },
  { name: 'Standard Chartered Bank',        code: '068' },
  { name: 'Sterling Bank',                  code: '232' },
  { name: 'Suntrust Bank',                  code: '100' },
  { name: 'Taj Bank',                       code: '302' },
  { name: 'Titan Trust Bank',               code: '102' },
  { name: 'Union Bank of Nigeria',          code: '032' },
  { name: 'United Bank for Africa (UBA)',   code: '033' },
  { name: 'Unity Bank',                     code: '215' },
  { name: 'VFD Microfinance Bank',          code: '090110' },
  { name: 'Wema Bank',                      code: '035' },
  { name: 'Zenith Bank',                    code: '057' },
];

// ─── GET /api/transfers/banks ─────────────────────────────────────────────────
let _banksCache = null;
let _banksCachedAt = 0;

const getBanks = async (req, res) => {
  try {
    // Serve cache if fresh (6 hrs)
    if (_banksCache && Date.now() - _banksCachedAt < 6 * 60 * 60 * 1000) {
      return res.json({ success: true, data: _banksCache });
    }
    // Try KoraPay live list first; fall back to static list on any error
    let banks;
    try {
      banks = await koraTransfer.getBanks();
      if (!banks || banks.length === 0) banks = NIGERIAN_BANKS;
    } catch (koraErr) {
      console.warn('[transfer] KoraPay bank list unavailable, using static fallback:', koraErr.message);
      banks = NIGERIAN_BANKS;
    }
    _banksCache    = banks;
    _banksCachedAt = Date.now();
    return res.json({ success: true, data: banks });
  } catch (err) {
    console.error('[transfer] getBanks error:', err.message);
    return res.json({ success: true, data: NIGERIAN_BANKS });
  }
};

// ─── POST /api/transfers/resolve ──────────────────────────────────────────────
const resolveAccount = async (req, res) => {
  const { bankCode, accountNumber } = req.body;
  if (!bankCode || !accountNumber) {
    return res.status(400).json({ success: false, message: 'bankCode and accountNumber are required.' });
  }
  if (!/^\d{10}$/.test(String(accountNumber))) {
    return res.status(400).json({ success: false, message: 'Account number must be exactly 10 digits.' });
  }
  try {
    const result = await koraTransfer.resolveAccount({ bankCode, accountNumber });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[transfer] resolveAccount error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: 'Could not verify account. Check the details and try again.' });
  }
};

// ─── POST /api/transfers/initiate ─────────────────────────────────────────────
// verifyPin middleware must run before this handler.
const initiateTransfer = async (req, res) => {
  const { amount, bankCode, bankName, accountNumber, accountName, narration } = req.body;
  const userId = req.user._id || req.user.id;

  // ── Validation ───────────────────────────────────────────────────────────────
  if (!amount || Number(amount) < MIN_TRANSFER) {
    return res.status(400).json({ success: false, message: `Minimum transfer amount is ₦${MIN_TRANSFER.toLocaleString()}.` });
  }
  if (!bankCode || !accountNumber || !accountName) {
    return res.status(400).json({ success: false, message: 'bankCode, accountNumber, and accountName are required.' });
  }
  if (!/^\d{10}$/.test(String(accountNumber))) {
    return res.status(400).json({ success: false, message: 'Account number must be exactly 10 digits.' });
  }

  const amountNum = Number(amount);

  try {
    const user = await User.findById(userId).select('+walletBalance +email');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // ── Balance check ────────────────────────────────────────────────────────
    if ((user.walletBalance || 0) < amountNum) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
      });
    }

    // ── Daily limit check ────────────────────────────────────────────────────
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayTotal = await Transaction.aggregate([
      { $match: { userId: user._id, type: 'bank_transfer', status: { $in: ['pending', 'success'] }, createdAt: { $gte: startOfDay } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const usedToday = todayTotal[0]?.total || 0;
    if (usedToday + amountNum > DAILY_LIMIT) {
      const remaining = DAILY_LIMIT - usedToday;
      return res.status(400).json({
        success: false,
        message: `Daily transfer limit is ₦${DAILY_LIMIT.toLocaleString()}. You can transfer ₦${Math.max(0, remaining).toLocaleString()} more today.`,
      });
    }

    // ── Deduct wallet + create pending transaction (atomic) ──────────────────
    const reference = `PF_TRF_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const session   = await mongoose.startSession();
    let txDoc;

    try {
      session.startTransaction();
      [txDoc] = await Transaction.create([{
        userId:        user._id,
        amount:        amountNum,
        reference,
        status:        'pending',
        type:          'bank_transfer',
        paymentMethod: 'wallet',
        metadata: { bankCode, bankName, accountNumber, accountName, narration: narration || '' },
      }], { session });
      await deductWalletBalance(user, amountNum, session);
      await session.commitTransaction();
    } catch (dbErr) {
      await session.abortTransaction();
      console.error('[transfer] debit failed:', dbErr.message);
      return res.status(500).json({ success: false, message: 'Could not process transfer. Please try again.' });
    } finally {
      session.endSession();
    }

    // ── Call KoraPay disburse ────────────────────────────────────────────────
    try {
      const koraResult = await koraTransfer.disburse({
        reference,
        amount:        amountNum,
        bankCode,
        accountNumber,
        accountName,
        narration:     narration || `PayFlex transfer to ${accountName}`,
        customerEmail: user.email,
      });

      await Transaction.findByIdAndUpdate(txDoc._id, { response: koraResult });

      const newBalance = (user.walletBalance || 0) - amountNum;
      return res.json({
        success:    true,
        message:    'Transfer initiated. Funds will be credited within minutes.',
        reference,
        status:     koraResult?.status || 'pending',
        newBalance,
      });
    } catch (koraErr) {
      // KoraPay rejected — refund wallet
      await refundWalletBalance(user, amountNum).catch(() => {});
      await Transaction.findByIdAndUpdate(txDoc._id, {
        status:        'failed',
        failureReason: koraErr.message,
        response:      koraErr.koraData,
      }).catch(() => {});
      console.error('[transfer] KoraPay disburse failed:', koraErr.message);
      return res.status(koraErr.statusCode || 502).json({
        success: false,
        message: koraErr.message || 'Transfer failed. Your wallet has been refunded.',
      });
    }
  } catch (err) {
    console.error('[transfer] initiateTransfer error:', err.message);
    return res.status(500).json({ success: false, message: 'Transfer could not be processed.' });
  }
};

// ─── GET /api/transfers/status/:reference ─────────────────────────────────────
const getTransferStatus = async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user._id || req.user.id;

    const tx = await Transaction.findOne({ reference, type: 'bank_transfer' }).lean();
    if (!tx) return res.status(404).json({ success: false, message: 'Transfer not found.' });
    if (String(tx.userId) !== String(userId)) return res.status(403).json({ success: false, message: 'Access denied.' });

    // If still pending, ask KoraPay for live status
    if (tx.status === 'pending') {
      try {
        const koraData = await koraTransfer.getTransferStatus(reference);
        if (koraData?.status === 'success') {
          await Transaction.findByIdAndUpdate(tx._id, { status: 'success', response: koraData });
          tx.status = 'success';
        } else if (koraData?.status === 'failed') {
          // Refund wallet if not already done
          const user = await User.findById(userId).select('+walletBalance');
          if (user) await refundWalletBalance(user, tx.amount).catch(() => {});
          await Transaction.findByIdAndUpdate(tx._id, { status: 'failed', response: koraData });
          tx.status = 'failed';
        }
      } catch {
        // KoraPay poll failure is non-fatal
      }
    }

    return res.json({ success: true, data: tx });
  } catch (err) {
    console.error('[transfer] getTransferStatus error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not fetch transfer status.' });
  }
};

// ─── GET /api/transfers/history ───────────────────────────────────────────────
const getTransferHistory = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const [transfers, total] = await Promise.all([
      Transaction.find({ userId, type: 'bank_transfer' })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Transaction.countDocuments({ userId, type: 'bank_transfer' }),
    ]);

    return res.json({ success: true, data: transfers, total, page: Number(page) });
  } catch (err) {
    console.error('[transfer] getTransferHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not fetch transfer history.' });
  }
};

module.exports = { getBanks, resolveAccount, initiateTransfer, getTransferStatus, getTransferHistory };
