'use strict';

const crypto   = require('crypto');
const mongoose = require('mongoose');

const vtuAfricaService   = require('../services/vtuAfricaService');
const pricingService     = require('../services/pricingService');
const ExamPinTransaction = require('../models/ExamPinTransaction');
const User               = require('../models/user');
const {
  deductWalletBalance,
  refundWalletBalance,
} = require('../util/paymentHelper');

// ─── Display names (labels only — not prices) ─────────────────────────────────
const DISPLAY_NAMES = {
  waec_1:   'WAEC Result Checker PIN',
  waec_2:   'WAEC GCE Registration PIN',
  waec_3:   'WAEC Verification PIN',
  neco_1:   'NECO Result Checker Token',
  neco_2:   'NECO GCE Registration PIN',
  nabteb_1: 'NABTEB Result Checker PIN',
  nabteb_2: 'NABTEB GCE Registration PIN',
  jamb_1:   'JAMB UTME Registration PIN',
  jamb_2:   'JAMB Direct Entry Registration PIN',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function featureEnabled() {
  return process.env.FEATURE_EXAM_PINS_ENABLED !== 'false';
}

function getProduct(examBody, productCode) {
  return pricingService.getExamPinPrice({
    examBody,
    productCode: String(productCode),
    forSomeoneElse: false,
  });
}

function getDisplayName(examBody, productCode) {
  return DISPLAY_NAMES[`${examBody}_${productCode}`] || `${examBody.toUpperCase()} PIN`;
}

/**
 * Detect if this purchase is for someone other than the authenticated user.
 * Exam PINs: compare candidate name (JAMB) or recipientPhone (others) against user record.
 * Basic substring match — no fuzzy matching needed at launch.
 */
function detectForSomeoneElse({ isJAMB, candidateName, recipientPhone, user }) {
  if (isJAMB && candidateName) {
    const userName = `${user.firstName || ''} ${user.lastName || ''}`.toLowerCase().trim();
    const candidate = candidateName.toLowerCase().trim();
    // If neither name contains the other, treat as "for someone else"
    if (userName && candidate && !userName.includes(candidate) && !candidate.includes(userName)) {
      return true;
    }
  }
  if (!isJAMB && recipientPhone) {
    const userPhone = (user.phoneNumber || user.phone || '').replace(/\s/g, '');
    const recipient = recipientPhone.replace(/\s/g, '');
    if (userPhone && recipient && userPhone !== recipient) {
      return true;
    }
  }
  return false;
}

// ─── GET /api/exam-pins/catalog ───────────────────────────────────────────────
const getCatalog = (req, res) => {
  const isAdmin  = req.user?.roles?.includes('admin');
  const catalog  = isAdmin
    ? pricingService.getInternalCatalog()
    : pricingService.getCatalog();

  const examPins = catalog.examPins;

  // Flatten all products from the array-based catalog
  const products = [];
  for (const [examBody, entries] of Object.entries(examPins)) {
    if (examBody === 'recipientFee') continue;
    const list = Array.isArray(entries) ? entries : [entries];
    for (const entry of list) {
      const key = `${examBody}_${entry.productCode}`;
      products.push({
        examBody,
        productCode:  entry.productCode,
        displayName:  DISPLAY_NAMES[key] || `${examBody.toUpperCase()} PIN`,
        sellingPrice: entry.userPays,
        available:    entry.available ?? true,
      });
    }
  }

  const response = products.map(p => ({
    examBody:     p.examBody,
    productCode:  p.productCode,
    displayName:  p.displayName,
    sellingPrice: p.sellingPrice,
    available:    p.available,
    ...(isAdmin && catalog._internal
      ? { costPrice: catalog._internal.examPinCosts[`${p.examBody}_${p.productCode}`] }
      : {}),
  }));

  return res.json({ success: true, products: response });
};

// ─── POST /api/exam-pins/verify-jamb ─────────────────────────────────────────
const verifyJambProfile = async (req, res) => {
  try {
    if (!featureEnabled()) {
      return res.status(503).json({ success: false, message: 'Exam PIN service is temporarily unavailable.' });
    }

    const { profilecode, productCode } = req.body;

    if (!profilecode || !productCode) {
      return res.status(400).json({ success: false, message: 'profilecode and productCode are required.' });
    }

    const pricing = getProduct('jamb', productCode);
    if (!pricing.available) {
      return res.status(400).json({ success: false, message: 'Invalid or unavailable JAMB product.' });
    }

    const result = await vtuAfricaService.verifyJambProfile({ profilecode, productCode });

    if (!result.ok || !result.candidateName) {
      return res.status(400).json({
        success: false,
        message: 'The profile code was not found. Please check and try again.',
      });
    }

    return res.json({
      success:       true,
      verified:      true,
      candidateName: result.candidateName,
      profileCode:   result.profileCode || profilecode,
      productName:   getDisplayName('jamb', productCode),
      productCode:   String(productCode),
      sellingPrice:  pricing.sellingPrice,
    });
  } catch (err) {
    console.error('[examPinController] verifyJambProfile error:', err.message);
    return res.status(502).json({ success: false, message: 'Verification service is temporarily unavailable. Please try again.' });
  }
};

// ─── POST /api/exam-pins/purchase ────────────────────────────────────────────
const purchase = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'Exam PIN service is temporarily unavailable.' });
  }

  const {
    examBody,
    productCode,
    quantity      = 1,
    profilecode,
    candidateName,
    recipientPhone,
    recipientEmail,
  } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!examBody || !productCode) {
    return res.status(400).json({ success: false, message: 'examBody and productCode are required.' });
  }

  const normalBody = examBody.toLowerCase();
  const isJAMB     = normalBody === 'jamb';

  if (isJAMB && (!profilecode || !recipientPhone || !recipientEmail)) {
    return res.status(400).json({
      success: false,
      message: 'JAMB purchases require profilecode, recipientPhone, and recipientEmail.',
    });
  }

  const qty = parseInt(quantity, 10);
  if (!qty || qty < 1 || qty > 50) {
    return res.status(400).json({ success: false, message: 'Quantity must be between 1 and 50.' });
  }

  // ── Load user first (needed for forSomeoneElse detection) ─────────────────
  const user = await User.findById(req.user.id).select('+walletBalance');
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  // ── Pricing ────────────────────────────────────────────────────────────────
  const forSomeoneElse = detectForSomeoneElse({ isJAMB, candidateName, recipientPhone, user });
  const pricing        = pricingService.getExamPinPrice({ examBody: normalBody, productCode: String(productCode), forSomeoneElse });

  if (!pricing.available) {
    return res.status(400).json({ success: false, message: 'Invalid or unavailable exam product.' });
  }

  // recipientFee is per transaction (flat), margin is per PIN × qty
  const totalUserPaid    = pricing.sellingPrice * qty + pricing.recipientFee;
  const totalProviderCost = pricing.ourCost * qty;
  const totalOurMargin   = totalUserPaid - totalProviderCost;
  const displayName      = getDisplayName(normalBody, String(productCode));

  // ── Balance check ─────────────────────────────────────────────────────────
  if ((user.walletBalance || 0) < totalUserPaid) {
    return res.status(400).json({
      success: false,
      message: `Insufficient wallet balance. Required: ₦${totalUserPaid.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
    });
  }

  // ── Rate limit check ──────────────────────────────────────────────────────
  const maxPerDay = parseInt(process.env.EXAM_PIN_MAX_PER_DAY_PER_USER || '20', 10);
  const dayStart  = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const todayCount = await ExamPinTransaction.countDocuments({
    userId:    req.user.id,
    status:    { $in: ['pending', 'success'] },
    createdAt: { $gte: dayStart },
  });

  if (todayCount >= maxPerDay) {
    return res.status(429).json({
      success: false,
      message: `Daily limit of ${maxPerDay} exam PIN purchases reached. Please try again tomorrow.`,
    });
  }

  // ── Generate idempotency ref ───────────────────────────────────────────────
  const ref = `payflex-exam-${crypto.randomUUID()}`;

  // ── Phase 1: Atomic debit + pending transaction record ────────────────────
  const session = await mongoose.startSession();
  let txDoc;

  try {
    session.startTransaction();

    [txDoc] = await ExamPinTransaction.create(
      [{
        userId:               req.user.id,
        ref,
        examBody:             normalBody,
        productCode:          String(productCode),
        productName:          displayName,
        quantity:             qty,
        unitPrice:            pricing.sellingPrice,
        totalCharged:         totalUserPaid,
        status:               'pending',
        jambProfileCode:      isJAMB ? profilecode   : undefined,
        jambCandidateName:    isJAMB ? candidateName : undefined,
        recipientPhone:       isJAMB ? recipientPhone : undefined,
        recipientEmail:       isJAMB ? recipientEmail : undefined,
        // Revenue tracking
        provider:             pricing.provider,
        userPaid:             totalUserPaid,
        providerCost:         totalProviderCost,
        providerFee:          pricing.providerFee,
        recipientFee:         pricing.recipientFee,
        ourMargin:            totalOurMargin,
        marginType:           pricing.marginType,
        forSomeoneElse,
        pricingConfigVersion: pricingService.getConfigVersion(),
      }],
      { session }
    );

    await deductWalletBalance(user, totalUserPaid, session);
    await session.commitTransaction();
  } catch (dbErr) {
    await session.abortTransaction();
    console.error('[examPinController] DB phase failed:', dbErr.message);
    return res.status(500).json({ success: false, message: 'Could not initiate transaction. Please try again.' });
  } finally {
    session.endSession();
  }

  // ── Phase 2: Call VTU Africa ───────────────────────────────────────────────
  let vtuResult;
  try {
    vtuResult = await vtuAfricaService.purchaseExamPin({
      service:      normalBody,
      product_code: String(productCode),
      quantity:     qty,
      ref,
      phone:        recipientPhone,
      profilecode:  isJAMB ? profilecode   : undefined,
      sender:       isJAMB ? recipientEmail : undefined,
      webhookURL:   process.env.VTUAFRICA_WEBHOOK_URL || '',
    });
  } catch (networkErr) {
    console.error('[examPinController] VTU Africa network error after wallet debit:', networkErr.message);
    return res.status(202).json({
      success:  false,
      pending:  true,
      message:  'Connection issue with the service provider. Your wallet is on hold and the transaction will be resolved automatically. Check your history in a few minutes.',
      data:     { ref, transactionId: txDoc._id },
    });
  }

  // ── VTU Africa confirmed failure ──────────────────────────────────────────
  if (!vtuResult.ok) {
    txDoc.status       = 'failed';
    txDoc.errorMessage = vtuResult.description?.message || 'Service rejected the request.';
    await txDoc.save();

    try {
      await refundWalletBalance(user, totalUserPaid);
    } catch (refundErr) {
      console.error('[examPinController] CRITICAL: refund failed after VTU Africa rejection:', {
        userId: req.user.id, ref, totalUserPaid, error: refundErr.message,
      });
    }

    return res.status(400).json({
      success: false,
      message: 'The service was unable to complete this request. Your wallet has been refunded. Please try again.',
    });
  }

  // ── Success ───────────────────────────────────────────────────────────────
  const isJAMBAsync = isJAMB && vtuResult.pins.length === 0;

  txDoc.vtuAfricaReferenceId = vtuResult.referenceId;
  txDoc.amountCharged        = vtuResult.amountCharged;
  txDoc.unitPrice            = vtuResult.unitPrice || pricing.sellingPrice;
  txDoc.vtuAfricaCommission  = vtuResult.commission;
  txDoc.status               = isJAMBAsync ? 'pending' : 'success';
  if (!isJAMBAsync) txDoc.pins = vtuResult.pins;
  await txDoc.save();

  if (isJAMBAsync) {
    return res.json({
      success: true,
      pending: true,
      message: 'Your JAMB PIN is being processed. It will be delivered to your phone and email, and will also appear in your transaction history.',
      data:    { ref, transactionId: txDoc._id },
    });
  }

  return res.json({
    success: true,
    message: 'Exam PIN purchased successfully.',
    data: {
      ref,
      transactionId: txDoc._id,
      examBody:      normalBody,
      productName:   displayName,
      quantity:      qty,
      totalCharged:  totalUserPaid,
      serviceFee:    pricing.recipientFee > 0 ? pricing.recipientFee : undefined,
      pins:          vtuResult.pins,
    },
  });
};

// ─── GET /api/exam-pins/history ───────────────────────────────────────────────
const getHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const skip  = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      ExamPinTransaction.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-vtuAfricaCommission -providerCost -ourMargin -pricingConfigVersion')
        .lean(),
      ExamPinTransaction.countDocuments({ userId: req.user.id }),
    ]);

    return res.json({
      success: true,
      data:    transactions,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[examPinController] getHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load history.' });
  }
};

module.exports = {
  getCatalog,
  verifyJambProfile,
  purchase,
  getHistory,
};
