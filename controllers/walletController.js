
const paystackService = require('../services/paystackService');
const walletService = require('../services/walletService');
const Payment = require('../models/Payment');

class WalletController {
  // Initialize wallet funding
  async fundWallet(req, res) {
    try {
      const { amount } = req.body; // Amount in Naira
      const userId = req.user.id;
      
      // Validate amount
      if (amount < 100) {
        return res.status(400).json({
          success: false,
          message: 'Minimum funding amount is ₦100'
        });
      }

      // Generate unique reference
      const reference = `WALLET_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Initialize Paystack transaction
      const paystackResponse = await paystackService.initializeTransaction(
        req.user.email,
        amount,
        reference,
        { 
          type: 'wallet_funding',
          userId 
        }
      );
      
      // Save payment record
      const payment = new Payment({
        userId,
        reference,
        amount,
        service: 'wallet_funding',
        status: 'pending'
      });
      await payment.save();
      
      res.status(200).json({
        success: true,
        data: {
          authorization_url: paystackResponse.data.authorization_url,
          access_code: paystackResponse.data.access_code,
          reference
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Verify wallet funding
  async verifyWalletFunding(req, res) {
    try {
      const { reference } = req.params;
      
      // Verify with Paystack
      const paystackResponse = await paystackService.verifyTransaction(reference);
      
      if (paystackResponse.data.status !== 'success') {
        return res.status(400).json({
          success: false,
          message: 'Payment verification failed'
        });
      }
      
      // Get payment record
      const payment = await Payment.findOne({ reference });
      
      if (payment.status === 'success') {
        return res.status(400).json({
          success: false,
          message: 'This transaction has already been processed'
        });
      }
      
      // Credit user wallet
      const result = await walletService.creditWallet(
        payment.userId,
        payment.amount,
        'Wallet Funding via Paystack',
        reference,
        { paymentMethod: 'paystack' }
      );
      
      // Update payment status
      payment.status = 'success';
      payment.paystackResponse = paystackResponse.data;
      await payment.save();
      
      res.status(200).json({
        success: true,
        message: 'Wallet funded successfully',
        data: {
          amount: payment.amount,
          newBalance: result.user.walletBalance
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get wallet balance
  async getBalance(req, res) {
    try {
      const userId = req.user.id;
      const balance = await walletService.getBalance(userId);
      
      res.status(200).json({
        success: true,
        data: { balance }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get wallet transaction history
  async getTransactionHistory(req, res) {
    try {
      const userId = req.user.id;
      const transactions = await walletService.getTransactions(userId);
      
      res.status(200).json({
        success: true,
        data: transactions
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
}

module.exports = new WalletController();