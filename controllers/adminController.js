'use strict';

const mongoose   = require('mongoose');
const User        = require('../models/user');
const Transaction = require('../models/transaction');

// ─── helpers ─────────────────────────────────────────────────────────────────

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
exports.getStats = async (req, res, next) => {
  try {
    const todayStart = startOfDay();

    const [
      totalUsers,
      newUsersToday,
      totalTransactions,
      successfulTx,
      failedTx,
      todayTx,
      volumeResult,
      todayVolumeResult,
    ] = await Promise.all([
      User.countDocuments({ isActive: true }),
      User.countDocuments({ createdAt: { $gte: todayStart } }),
      Transaction.countDocuments(),
      Transaction.countDocuments({ status: { $in: ['success', 'completed'] } }),
      Transaction.countDocuments({ status: 'failed' }),
      Transaction.countDocuments({ createdAt: { $gte: todayStart } }),
      Transaction.aggregate([
        { $match: { status: { $in: ['success', 'completed'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { status: { $in: ['success', 'completed'] }, createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers,
        newUsersToday,
        totalTransactions,
        successfulTransactions: successfulTx,
        failedTransactions: failedTx,
        todayTransactions: todayTx,
        totalVolume: volumeResult[0]?.total || 0,
        todayVolume: todayVolumeResult[0]?.total || 0,
      },
    });
  } catch (err) { next(err); }
};

// ─── GET /api/admin/transactions ─────────────────────────────────────────────
exports.getTransactions = async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const skip   = (page - 1) * limit;
    const { status, type, search } = req.query;

    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (type   && type   !== 'all') filter.type   = type;
    if (search) {
      filter.$or = [
        { reference:   { $regex: search, $options: 'i' } },
        { phoneNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'firstName lastName email phone')
        .lean(),
      Transaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

// ─── GET /api/admin/transactions/:reference ───────────────────────────────────
exports.getTransaction = async (req, res, next) => {
  try {
    const tx = await Transaction.findOne({ reference: req.params.reference })
      .populate('userId', 'firstName lastName email phone walletBalance')
      .lean();
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
    res.json({ success: true, transaction: tx });
  } catch (err) { next(err); }
};

// ─── POST /api/admin/transactions/:reference/refund ───────────────────────────
exports.refundTransaction = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const tx = await Transaction.findOne({ reference: req.params.reference }).session(session);
    if (!tx) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    if (tx.status === 'refunded') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Transaction already refunded' });
    }
    if (!['success', 'completed', 'failed'].includes(tx.status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Cannot refund a transaction with status: ${tx.status}` });
    }

    const user = await User.findById(tx.userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.walletBalance = (user.walletBalance || 0) + tx.amount;
    tx.status = 'refunded';
    tx.refundedAt = new Date();
    tx.refundedBy = req.user._id || req.user.id;
    tx.refundNote = req.body.note || 'Admin refund';

    await user.save({ session });
    await tx.save({ session });
    await session.commitTransaction();

    res.json({
      success: true,
      message: `₦${tx.amount.toLocaleString()} refunded to ${user.firstName} ${user.lastName}`,
      newBalance: user.walletBalance,
    });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
exports.getUsers = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;
    const { search } = req.query;

    const filter = {};
    if (search) {
      filter.$or = [
        { firstName:  { $regex: search, $options: 'i' } },
        { lastName:   { $regex: search, $options: 'i' } },
        { email:      { $regex: search, $options: 'i' } },
        { phone:      { $regex: search, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('firstName lastName email phone walletBalance isActive isPhoneVerified kyc roles createdAt')
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      users,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────
exports.getUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('firstName lastName email phone walletBalance isActive isPhoneVerified kyc roles createdAt referralCode totalReferrals referralEarnings')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const [txCount, txVolume] = await Promise.all([
      Transaction.countDocuments({ userId: user._id, status: { $in: ['success', 'completed'] } }),
      Transaction.aggregate([
        { $match: { userId: user._id, status: { $in: ['success', 'completed'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const recentTx = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    res.json({
      success: true,
      user,
      stats: { txCount, totalSpent: txVolume[0]?.total || 0 },
      recentTransactions: recentTx,
    });
  } catch (err) { next(err); }
};

// ─── PATCH /api/admin/users/:id/toggle-active ─────────────────────────────────
exports.toggleUserActive = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.isActive = !user.isActive;
    await user.save();

    res.json({
      success: true,
      message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      isActive: user.isActive,
    });
  } catch (err) { next(err); }
};
