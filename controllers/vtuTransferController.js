'use strict';

const crypto      = require('crypto');
const Transaction = require('../models/transaction');
const User        = require('../models/user');
const vtuTransfer = require('../services/vtuAfricaTransferService');
const { deductWalletBalance, refundWalletBalance } = require('../util/paymentHelper');

const MIN_TRANSFER = 500;
const DAILY_LIMIT  = 200_000;

// ─── GET /api/vtransfers/banks ────────────────────────────────────────────────
const getBanks = (req, res) => {
  return res.json({ success: true, data: vtuTransfer.getBanks() });
};

// ─── POST /api/vtransfers/resolve ─────────────────────────────────────────────
const resolveAccount = async (req, res) => {
  const { bankCode, accountNumber } = req.body;
  if (!bankCode || !accountNumber) {
    return res.status(400).json({ success: false, message: 'bankCode and accountNumber are required.' });
  }
  if (!/^\d{10}$/.test(String(accountNumber))) {
    return res.status(400).json({ success: false, message: 'Account number must be exactly 10 digits.' });
  }
  try {
    const result = await vtuTransfer.resolveAccount({ bankCode, accountNo: accountNumber });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[vtuTransfer] resolveAccount error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: 'Could not verify account. Check the details and try again.' });
  }
};

// ─── POST /api/vtransfers/initiate ────────────────────────────────────────────
const initiateTransfer = async (req, res) => {
  const { amount, bankCode, bankName, accountNumber, accountName, narration } = req.body;
  const userId = req.user._id || req.user.id;

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
    const user = await User.findById(userId).select('+walletBalance +email +firstName +lastName');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if ((user.walletBalance || 0) < amountNum) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
      });
    }

    // Daily limit check
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayTotal = await Transaction.aggregate([
      { $match: { userId: user._id, type: 'bank_transfer', provider: 'vtu-africa', status: { $in: ['processing', 'success'] }, createdAt: { $gte: startOfDay } } },
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

    // Deduct wallet atomically + create transaction
    const reference = `PFX-VTR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    let txDoc;
    try {
      const mongoose = require('mongoose');
      const session  = await mongoose.startSession();
      session.startTransaction();
      [txDoc] = await Transaction.create([{
        userId,
        amount:        amountNum,
        reference,
        status:        'processing',
        type:          'bank_transfer',
        provider:      'vtu-africa',
        paymentMethod: 'wallet',
        metadata:      { bankCode, bankName, accountNumber, accountName, narration: narration || '' },
      }], { session });
      await deductWalletBalance(user, amountNum, session);
      await session.commitTransaction();
      session.endSession();
    } catch (dbErr) {
      console.error('[vtuTransfer] debit failed:', dbErr.message);
      return res.status(500).json({ success: false, message: 'Could not process transfer. Please try again.' });
    }

    // Call VTU Africa sendmoney
    try {
      const senderName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'PayFlex';
      const result     = await vtuTransfer.sendMoney({
        accountNo:  accountNumber,
        bankcode:   bankCode,
        amount:     amountNum,
        sender:     narration || senderName,
        ref:        reference,
        webhookURL: `${process.env.BASE_URL}/api/vtu-africa/webhook`,
      });

      const status = result?.Status === 'Completed' ? 'success' : 'processing';
      await Transaction.findByIdAndUpdate(txDoc._id, { status, response: result });

      const newBalance = (user.walletBalance || 0) - amountNum;
      return res.json({
        success:    true,
        message:    status === 'success'
          ? 'Transfer successful.'
          : 'Transfer initiated. You will be notified once confirmed.',
        reference,
        status,
        newBalance,
      });
    } catch (vtuErr) {
      const httpStatus = vtuErr.statusCode || 502;
      console.error('[vtuTransfer] sendMoney error:', httpStatus, vtuErr.message);

      // 5xx / network error — do NOT refund yet, reconciliation will resolve
      if (httpStatus >= 500 || vtuErr.code === 'ECONNABORTED') {
        await Transaction.findByIdAndUpdate(txDoc._id, {
          failureReason: `VTU call uncertain: ${vtuErr.message}`,
          response:      vtuErr.vtuData,
        }).catch(() => {});
        return res.status(202).json({
          success:   true,
          reference,
          status:    'processing',
          message:   'Transfer submitted. We are confirming with the bank — you will be notified of the outcome.',
        });
      }

      // Definitive failure (4xx / bad response) — refund
      await refundWalletBalance(user, amountNum).catch(() => {});
      await Transaction.findByIdAndUpdate(txDoc._id, {
        status:        'failed',
        failureReason: vtuErr.message,
        response:      vtuErr.vtuData,
      }).catch(() => {});
      return res.status(httpStatus).json({
        success: false,
        message: vtuErr.message || 'Transfer failed. Your wallet has been refunded.',
      });
    }
  } catch (err) {
    console.error('[vtuTransfer] initiateTransfer error:', err.message);
    return res.status(500).json({ success: false, message: 'Transfer could not be processed.' });
  }
};

// ─── GET /api/vtransfers/status/:reference ────────────────────────────────────
const getTransferStatus = async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user._id || req.user.id;

    const tx = await Transaction.findOne({ reference, type: 'bank_transfer', provider: 'vtu-africa' }).lean();
    if (!tx) return res.status(404).json({ success: false, message: 'Transfer not found.' });
    if (String(tx.userId) !== String(userId)) return res.status(403).json({ success: false, message: 'Access denied.' });

    if (tx.status === 'processing') {
      try {
        const result = await vtuTransfer.queryTransfer({ ref: reference });
        const desc   = result?.description || {};
        if (desc.Status === 'Completed') {
          await Transaction.findByIdAndUpdate(tx._id, { status: 'success', response: desc });
          tx.status = 'success';
        } else if (result?.ok === false) {
          const user = await User.findById(userId).select('+walletBalance');
          if (user) await refundWalletBalance(user, tx.amount).catch(() => {});
          await Transaction.findByIdAndUpdate(tx._id, { status: 'failed', response: desc });
          tx.status = 'failed';
        }
      } catch { /* non-fatal */ }
    }

    return res.json({ success: true, data: tx });
  } catch (err) {
    console.error('[vtuTransfer] getTransferStatus error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not fetch transfer status.' });
  }
};

// ─── GET /api/vtransfers/history ──────────────────────────────────────────────
const getTransferHistory = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const [transfers, total] = await Promise.all([
      Transaction.find({ userId, type: 'bank_transfer', provider: 'vtu-africa' })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Transaction.countDocuments({ userId, type: 'bank_transfer', provider: 'vtu-africa' }),
    ]);

    return res.json({ success: true, data: transfers, total, page: Number(page) });
  } catch (err) {
    console.error('[vtuTransfer] getTransferHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not fetch transfer history.' });
  }
};

module.exports = { getBanks, resolveAccount, initiateTransfer, getTransferStatus, getTransferHistory };
