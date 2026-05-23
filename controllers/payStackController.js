const crypto = require("crypto");
const paystackService = require("../service/payStackServices");
const Transaction = require("../models/transaction");
const User = require("../models/user");

// ============================================
// INITIALIZE WALLET TOP-UP
// POST /api/payment/initialize
// ============================================
exports.initializePayment = async (req, res) => {
  try {
    const { amount } = req.body;
    const user = req.user;

    if (!amount || Number(amount) < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimum top-up amount is ₦100",  
      }); 
    }

    if (!user.email) {
      return res.status(400).json({
        success: false,
        message: "An email address is required to process card payments. Please add one to your profile.",
      });
    }

    const amountNaira = Number(amount);
    const reference = `PF_TOPUP_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    const paystackResponse = await paystackService.initializeTransaction(
      user.email,
      amountNaira,
      reference,
      { userId: user._id.toString(), purpose: "wallet_topup" }
    );

    if (!paystackResponse.status) {
      return res.status(500).json({
        success: false,
        message: "Failed to initialize payment",
      });
    }

    // Create a pending transaction record so we can match the webhook
    await Transaction.create({
      userId: user._id,
      type: "wallet_topup",
      amount: amountNaira,
      reference,
      status: "pending",
      paymentMethod: "card",
      metadata: { paystackRef: reference },
    });

    return res.status(200).json({
      success: true,
      data: {
        authorization_url: paystackResponse.data.authorization_url,
        access_code: paystackResponse.data.access_code,
        reference,
      },
    });
  } catch (error) {
    console.error("❌ Initialize payment error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================
// VERIFY PAYMENT & CREDIT WALLET
// GET /api/payment/verify/:reference
// ============================================
exports.verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;

    // Find the pending transaction
    const transaction = await Transaction.findOne({ reference });
    if (!transaction) {
      return res.status(404).json({ success: false, message: "Transaction not found" });
    }

    if (transaction.status !== "pending") {
      return res.status(200).json({
        success: true,
        message: "Transaction already processed",
        data: { status: transaction.status, amount: transaction.amount },
      });
    }

    const paystackResponse = await paystackService.verifyTransaction(reference);

    if (!paystackResponse.status || paystackResponse.data.status !== "success") {
      transaction.status = "failed";
      transaction.failureReason = paystackResponse.data?.gateway_response || "Payment not successful";
      await transaction.save();
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    // Credit wallet atomically
    const amountPaid = paystackResponse.data.amount / 100; // kobo → naira
    const user = await User.findById(transaction.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.walletBalance = (user.walletBalance || 0) + amountPaid;
    await user.save();

    transaction.status = "success";
    transaction.response = paystackResponse.data;
    transaction.paidAt = new Date();
    await transaction.save();

    console.log(`✅ Wallet credited ₦${amountPaid} for user ${user._id}`);

    return res.status(200).json({
      success: true,
      message: `₦${amountPaid.toLocaleString()} added to your wallet`,
      data: {
        amount: amountPaid,
        newBalance: user.walletBalance,
        reference,
      },
    });
  } catch (error) {
    console.error("❌ Verify payment error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================
// PAYSTACK WEBHOOK (idempotent)
// POST /api/payment/webhook
// ============================================
exports.handleWebhook = async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const hash = crypto
      .createHmac("sha512", secret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      console.warn("⚠️ Invalid Paystack webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const { reference } = event.data;
      const transaction = await Transaction.findOne({ reference });

      // Already processed — respond 200 so Paystack stops retrying
      if (!transaction || transaction.status !== "pending") {
        return res.sendStatus(200);
      }

      const amountPaid = event.data.amount / 100;
      const user = await User.findById(transaction.userId);

      if (user) {
        user.walletBalance = (user.walletBalance || 0) + amountPaid;
        await user.save();
        console.log(`✅ Webhook: wallet credited ₦${amountPaid} for user ${user._id}`);
      }

      transaction.status = "success";
      transaction.response = event.data;
      transaction.paidAt = new Date();
      await transaction.save();
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
    res.sendStatus(500);
  }
};

// ============================================
// WALLET TOP-UP HISTORY
// GET /api/payment/history
// ============================================
exports.getPaymentHistory = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 20 } = req.query;

    const transactions = await Transaction.find({
      userId,
      type: "wallet_topup",
    })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    return res.status(200).json({
      success: true,
      data: transactions,
    });
  } catch (error) {
    console.error("❌ Payment history error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};
