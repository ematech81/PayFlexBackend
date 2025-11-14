
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const mongoose = require('mongoose');

class WalletService {
  // Credit wallet (add money)
  async creditWallet(userId, amount, description, reference, metadata = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const user = await User.findById(userId).session(session);
      
      if (!user) {
        throw new Error('User not found');
      }

      const balanceBefore = user.walletBalance;
      const balanceAfter = balanceBefore + amount;

      // Update user wallet
      user.walletBalance = balanceAfter;
      await user.save({ session });

      // Create transaction record
      const transaction = new WalletTransaction({
        userId,
        type: 'credit',
        amount,
        balanceBefore,
        balanceAfter,
        description,
        reference,
        metadata
      });
      await transaction.save({ session });

      await session.commitTransaction();
      
      return { user, transaction };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Debit wallet (remove money)
  async debitWallet(userId, amount, description, reference, metadata = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const user = await User.findById(userId).session(session);
      
      if (!user) {
        throw new Error('User not found');
      }

      if (user.walletBalance < amount) {
        throw new Error('Insufficient wallet balance');
      }

      const balanceBefore = user.walletBalance;
      const balanceAfter = balanceBefore - amount;

      // Update user wallet
      user.walletBalance = balanceAfter;
      await user.save({ session });

      // Create transaction record
      const transaction = new WalletTransaction({
        userId,
        type: 'debit',
        amount,
        balanceBefore,
        balanceAfter,
        description,
        reference,
        metadata
      });
      await transaction.save({ session });

      await session.commitTransaction();
      
      return { user, transaction };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Get wallet balance
  async getBalance(userId) {
    const user = await User.findById(userId);
    return user ? user.walletBalance : 0;
  }

  // Get wallet transactions
  async getTransactions(userId, limit = 50) {
    return await WalletTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit);
  }
}

module.exports = new WalletService();