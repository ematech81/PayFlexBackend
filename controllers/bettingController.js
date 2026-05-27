'use strict';

const crypto             = require('crypto');
const mongoose           = require('mongoose');
const vtuAfricaService   = require('../services/vtuAfricaService');
const pricingService     = require('../services/pricingService');
const BettingTransaction = require('../models/BettingTransaction');
const User               = require('../models/user');
const {
  deductWalletBalance,
  refundWalletBalance,
} = require('../util/paymentHelper');

// ─── Platform registry ────────────────────────────────────────────────────────
const BETTING_PLATFORMS = [
  { code: 'bet9ja',       displayName: 'Bet9ja',       available: true },
  { code: 'betking',      displayName: 'BetKing',      available: true },
  { code: '1xbet',        displayName: '1xBet',        available: true },
  { code: 'nairabet',     displayName: 'NairaBet',     available: true },
  { code: 'betbiga',      displayName: 'BetBiga',      available: true },
  { code: 'merrybet',     displayName: 'MerryBet',     available: true },
  { code: 'sportybet',    displayName: 'SportyBet',    available: true },
  { code: 'naijabet',     displayName: 'NaijaBet',     available: true },
  { code: 'betway',       displayName: 'Betway',       available: true },
  { code: 'bangbet',      displayName: 'BangBet',      available: true },
  { code: 'melbet',       displayName: 'MelBet',       available: true },
  { code: 'livescorebet', displayName: 'LiveScoreBet', available: true },
  { code: 'naira-million',displayName: 'Naira-Million',available: true },
  { code: 'cloudbet',     displayName: 'CloudBet',     available: true },
  { code: 'paripesa',     displayName: 'Paripesa',     available: true },
  { code: 'mylottohub',   displayName: 'MylottoHub',   available: true },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function featureEnabled() {
  return process.env.FEATURE_BETTING_ENABLED !== 'false';
}

function findPlatform(code) {
  return BETTING_PLATFORMS.find(p => p.code === code.toLowerCase());
}

/**
 * Detect if this bet funding is for someone other than the authenticated user.
 * Compare the verified account holder name against the user's registered name.
 */
function detectForSomeoneElse({ customerName, user }) {
  if (!customerName) return false;
  const userName = `${user.firstName || ''} ${user.lastName || ''}`.toLowerCase().trim();
  const holder   = customerName.toLowerCase().trim();
  if (!userName || !holder) return false;
  return !userName.includes(holder) && !holder.includes(userName);
}

// ─── GET /api/betting/platforms ───────────────────────────────────────────────
const getPlatforms = (req, res) => {
  const isAdmin   = req.user?.roles?.includes('admin');
  const platforms = isAdmin
    ? BETTING_PLATFORMS
    : BETTING_PLATFORMS.filter(p => p.available);

  const catalog = pricingService.getCatalog().betting;

  return res.json({
    success:        true,
    platforms:      platforms.map(p => ({ code: p.code, displayName: p.displayName, available: p.available })),
    minAmount:      catalog.minAmount,
    maxAmount:      catalog.maxAmount,
    normalFee:      catalog.normalFee,
    microFee:       catalog.microFee,
    microThreshold: catalog.microThreshold,
  });
};

// ─── POST /api/betting/verify-account ────────────────────────────────────────
const verifyAccount = async (req, res) => {
  try {
    if (!featureEnabled()) {
      return res.status(503).json({ success: false, message: 'Betting wallet funding is temporarily unavailable.' });
    }

    const { platform, userid } = req.body;

    if (!platform || !userid) {
      return res.status(400).json({ success: false, message: 'platform and userid are required.' });
    }

    const platformInfo = findPlatform(platform);
    if (!platformInfo || !platformInfo.available) {
      return res.status(400).json({ success: false, message: 'Unsupported betting platform.' });
    }

    const result = await vtuAfricaService.verifyBetAccount({
      service: platform.toLowerCase(),
      userid:  String(userid),
    });

    if (!result.ok) {
      return res.status(400).json({
        success: false,
        message: `Account not found on ${platformInfo.displayName}. Please check your user ID and try again.`,
      });
    }

    return res.json({
      success:      true,
      verified:     true,
      customerName: result.customerName || null,
      userId:       String(userid),
      platform:     platform.toLowerCase(),
      platformName: platformInfo.displayName,
    });
  } catch (err) {
    console.error('[bettingController] verifyAccount error:', err.message);
    return res.status(502).json({ success: false, message: 'Verification service is temporarily unavailable. Please try again.' });
  }
};

// ─── POST /api/betting/fund ───────────────────────────────────────────────────
// Fee model: we know the full fee before calling VTU Africa.
//   Normal (≥₦500): userPays = amount + ₦30 (₦20 VTU fee + ₦10 our margin)
//   Micro  (<₦500): userPays = amount + ₦50 (₦20 VTU fee + ₦30 our margin)
//   forSomeoneElse: +₦20 recipient fee on top
//
// We debit userPays from the user's wallet atomically before calling VTU Africa.
// If VTU Africa fails, we refund userPays in full. No second deduction pass.
const fund = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'Betting wallet funding is temporarily unavailable.' });
  }

  const { platform, userid, customerName, amount } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!platform || !userid || !amount) {
    return res.status(400).json({ success: false, message: 'platform, userid, and amount are required.' });
  }

  const platformInfo = findPlatform(platform);
  if (!platformInfo || !platformInfo.available) {
    return res.status(400).json({ success: false, message: 'Unsupported betting platform.' });
  }

  const requestAmount = parseFloat(amount);
  if (isNaN(requestAmount)) {
    return res.status(400).json({ success: false, message: 'amount must be a number.' });
  }

  // ── Pricing ───────────────────────────────────────────────────────────────
  // getBettingPrice throws with statusCode:400 if below minimum
  let pricing;
  try {
    const user = await User.findById(req.user.id).select('+walletBalance');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const forSomeoneElse = detectForSomeoneElse({ customerName, user });
    pricing = pricingService.getBettingPrice({ amount: requestAmount, forSomeoneElse });

    // ── Balance check ───────────────────────────────────────────────────────
    if ((user.walletBalance || 0) < pricing.userPays) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. Required: ₦${pricing.userPays.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
      });
    }

    // ── Rate limit ──────────────────────────────────────────────────────────
    const maxPerDay = parseInt(process.env.BETTING_MAX_PER_DAY_PER_USER || '20', 10);
    const dayStart  = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const todayCount = await BettingTransaction.countDocuments({
      userId:    req.user.id,
      status:    { $in: ['pending', 'success'] },
      createdAt: { $gte: dayStart },
    });

    if (todayCount >= maxPerDay) {
      return res.status(429).json({
        success: false,
        message: `Daily limit of ${maxPerDay} betting wallet funding transactions reached. Please try again tomorrow.`,
      });
    }

    // ── Generate ref ────────────────────────────────────────────────────────
    const ref = `payflex-bet-${crypto.randomUUID()}`;

    // ── Phase 1: Atomic debit + pending record ──────────────────────────────
    // We debit the full userPays (amount + service fee) upfront.
    // If VTU Africa fails, we refund userPays in full. No second deduction.
    const session = await mongoose.startSession();
    let txDoc;

    try {
      session.startTransaction();

      [txDoc] = await BettingTransaction.create(
        [{
          userId:                 req.user.id,
          ref,
          bettingPlatform:        platform.toLowerCase(),
          bettingPlatformDisplay: platformInfo.displayName,
          customerId:             String(userid),
          customerName:           customerName || null,
          requestAmount,
          totalCharged:           pricing.userPays,
          status:                 'pending',
          // Revenue tracking
          provider:               pricing.provider,
          userPaid:               pricing.userPays,
          providerCost:           pricing.vtuAfricaCost,
          providerFee:            pricing.providerFee,
          recipientFee:           pricing.recipientFee,
          ourMargin:              pricing.ourMargin,
          marginType:             pricing.marginType,
          forSomeoneElse,
          pricingConfigVersion:   pricingService.getConfigVersion(),
        }],
        { session }
      );

      await deductWalletBalance(user, pricing.userPays, session);
      await session.commitTransaction();
    } catch (dbErr) {
      await session.abortTransaction();
      console.error('[bettingController] DB phase failed:', dbErr.message);
      return res.status(500).json({ success: false, message: 'Could not initiate transaction. Please try again.' });
    } finally {
      session.endSession();
    }

    // ── Phase 2: Call VTU Africa ────────────────────────────────────────────
    let vtuResult;
    try {
      vtuResult = await vtuAfricaService.fundBetWallet({
        service:    platform.toLowerCase(),
        userid:     String(userid),
        amount:     requestAmount,
        ref,
        webhookURL: process.env.VTUAFRICA_WEBHOOK_URL || '',
      });
    } catch (networkErr) {
      console.error('[bettingController] VTU Africa network error after wallet debit:', networkErr.message);
      return res.status(202).json({
        success: false,
        pending: true,
        message: 'Connection issue with the service provider. Your wallet is on hold and the transaction will be resolved automatically. Check your history in a few minutes.',
        data:    { ref, transactionId: txDoc._id },
      });
    }

    // ── VTU Africa confirmed failure ────────────────────────────────────────
    if (!vtuResult.ok) {
      txDoc.status       = 'failed';
      txDoc.errorMessage = vtuResult.description?.message || 'Service rejected the request.';
      await txDoc.save();

      try {
        await refundWalletBalance(user, pricing.userPays);
      } catch (refundErr) {
        console.error('[bettingController] CRITICAL: refund failed after VTU Africa rejection:', {
          userId: req.user.id, ref, userPays: pricing.userPays, error: refundErr.message,
        });
      }

      return res.status(400).json({
        success: false,
        message: 'The service was unable to complete this request. Your wallet has been refunded. Please try again.',
      });
    }

    // ── Success ───────────────────────────────────────────────────────────
    txDoc.status               = 'success';
    txDoc.vtuAfricaReferenceId = vtuResult.referenceId;
    txDoc.vtuAfricaCharge      = vtuResult.charge        || 0;
    txDoc.amountCharged        = vtuResult.amountCharged || requestAmount;
    txDoc.vtuAfricaCommission  = vtuResult.commission;
    await txDoc.save();

    return res.json({
      success: true,
      message: `₦${requestAmount.toLocaleString()} has been funded to your ${platformInfo.displayName} account.`,
      data: {
        ref,
        transactionId:   txDoc._id,
        platform:        platform.toLowerCase(),
        platformName:    platformInfo.displayName,
        userId:          String(userid),
        customerName:    customerName || null,
        requestAmount,
        serviceFee:      pricing.breakdown.serviceFee,
        recipientFee:    pricing.recipientFee > 0 ? pricing.recipientFee : undefined,
        totalCharged:    pricing.userPays,
      },
    });

  } catch (err) {
    // Catches getBettingPrice throw (amount below minimum) and unexpected errors
    const status = err.statusCode || 500;
    const message = status === 400
      ? err.message
      : 'An unexpected error occurred. Please try again.';
    console.error('[bettingController] fund error:', err.message);
    return res.status(status).json({ success: false, message });
  }
};

// ─── GET /api/betting/history ─────────────────────────────────────────────────
const getHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const skip  = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      BettingTransaction.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-vtuAfricaCommission -providerCost -ourMargin -pricingConfigVersion')
        .lean(),
      BettingTransaction.countDocuments({ userId: req.user.id }),
    ]);

    return res.json({
      success: true,
      data:    transactions,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[bettingController] getHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load history.' });
  }
};

module.exports = {
  getPlatforms,
  verifyAccount,
  fund,
  getHistory,
};
