'use strict';

const crypto          = require('crypto');
const mongoose        = require('mongoose');
const cacVasService   = require('../services/cacVasService');
const pricingService  = require('../services/pricingService');
const CACRegistration = require('../models/cacRegistration');
const CACValidation   = require('../models/cacValidation');
const Transaction     = require('../models/transaction');
const User            = require('../models/user');
const {
  deductWalletBalance,
  refundWalletBalance,
} = require('../util/paymentHelper');

// ─── Feature flag ─────────────────────────────────────────────────────────────
function featureEnabled() {
  return process.env.FEATURE_CAC_ENABLED !== 'false';
}

// ─── Webhook signature ────────────────────────────────────────────────────────
function verifyWebhookSig(rawBody, headerSig) {
  const secret = process.env.CAC_VAS_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[cac] CAC_VAS_WEBHOOK_SECRET not set — skipping signature check');
    return true;
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(headerSig || '', 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

// ─── Search type registry ─────────────────────────────────────────────────────
// Maps frontend validationType → pricing key + VAS API call.
const SEARCH_TYPES = {
  rc_number:    { priceKey: 'validate_basic',   call: (p) => cacVasService.getCompanyByRC({ rcNumber: p })   },
  company_name: { priceKey: 'validate_basic',   call: (p) => cacVasService.getCompanyByName({ name: p })     },
  tin:          { priceKey: 'validate_basic',   call: (p) => cacVasService.getCompanyByTIN({ tin: p })       },
  generate_tin: { priceKey: 'validate_basic',   call: (p) => cacVasService.generateTIN({ rcNumber: p })      },
  vrc_share_distribution: { priceKey: 'validate_vrc',     call: (p) => cacVasService.getVRCReport({ vrc: p, reportType: 'share_distribution' }) },
  vrc_share_capital:      { priceKey: 'validate_vrc',     call: (p) => cacVasService.getVRCReport({ vrc: p, reportType: 'share_capital' })      },
  vrc_assets:             { priceKey: 'validate_vrc',     call: (p) => cacVasService.getVRCReport({ vrc: p, reportType: 'assets' })              },
  vrc_status_report:      { priceKey: 'validate_premium', call: (p) => cacVasService.getVRCReport({ vrc: p, reportType: 'status_report' })       },
  vrc_certificate:        { priceKey: 'validate_premium', call: (p) => cacVasService.getVRCReport({ vrc: p, reportType: 'certificate' })         },
  vrc_wind_up:            { priceKey: 'validate_premium', call: (p) => cacVasService.getVRCReport({ vrc: p, reportType: 'wind_up' })             },
  vrc_affiliates:         { priceKey: 'validate_premium', call: (p) => cacVasService.getVRCReport({ vrc: p, reportType: 'affiliates' })          },
  vrc_company:            { priceKey: 'validate_premium', call: (p) => cacVasService.getVRCReport({ vrc: p, reportType: 'company' })             },
};

// ─── GET /api/cac/prices ──────────────────────────────────────────────────────
const getPrices = (_req, res) => {
  const p = (type) => pricingService.getCACPrice(type).userPays;
  return res.json({
    success: true,
    prices: {
      businessName: {
        standard:     p('bn_standard'),
        priority:     p('bn_priority'),
        certificate:  p('bn_certificate'),
        statusReport: p('bn_status_report'),
      },
      validation: {
        basic:   p('validate_basic'),
        vrc:     p('validate_vrc'),
        premium: p('validate_premium'),
      },
    },
  });
};

// ─── POST /api/cac/validate-name ──────────────────────────────────────────────
// Free BN name availability check — no wallet debit, no PIN required.
const validateName = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { proposedName } = req.body;
  if (!proposedName || !String(proposedName).trim()) {
    return res.status(400).json({ success: false, message: 'proposedName is required.' });
  }

  try {
    const vasResult = await cacVasService.validateBusinessName({
      proposedName: String(proposedName).trim(),
    });
    return res.json({ success: true, data: vasResult });
  } catch (err) {
    console.error('[cac] validateName error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── POST /api/cac/register/business-name ────────────────────────────────────
// Paid. verifyPin middleware runs before this handler.
// Phase 1: atomic debit + create pending records (MongoDB session).
// Phase 2: submit to VAS API (outside session — refund on failure).
const registerBusinessName = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { proposedName, registrationData, priorityService = false } = req.body;

  if (!proposedName || !registrationData) {
    return res.status(400).json({ success: false, message: 'proposedName and registrationData are required.' });
  }

  const priceKey = priorityService ? 'bn_priority' : 'bn_standard';
  const pricing  = pricingService.getCACPrice(priceKey);

  let user;
  try {
    user = await User.findById(req.user.id).select('+walletBalance');
  } catch (dbErr) {
    console.error('[cac] registerBusinessName user lookup failed:', dbErr.message);
    return res.status(500).json({ success: false, message: 'Could not retrieve user. Please try again.' });
  }
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  if ((user.walletBalance || 0) < pricing.userPays) {
    return res.status(400).json({
      success: false,
      message: `Insufficient wallet balance. Required: ₦${pricing.userPays.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
    });
  }

  const transactionRef = `CACREG${Date.now()}`;
  const txRef          = `cac-reg-${crypto.randomUUID()}`;

  // ── Phase 1: atomic debit + pending records ───────────────────────────────
  const session = await mongoose.startSession();
  let regDoc, txDoc;

  try {
    session.startTransaction();

    [regDoc] = await CACRegistration.create(
      [{
        userId:               req.user.id,
        transactionRef,
        registrationType:     'business_name',
        proposedName:         String(proposedName).trim(),
        registrationData,
        status:               'pending',
        priorityService:      !!priorityService,
        userPaid:             pricing.userPays,
        vasCost:              pricing.vasCost,
        ourMargin:            pricing.ourMargin,
        billingTransactionRef: txRef,
      }],
      { session }
    );

    [txDoc] = await Transaction.create(
      [{
        userId:               req.user.id,
        amount:               pricing.userPays,
        reference:            txRef,
        status:               'pending',
        type:                 'cac_registration',
        paymentMethod:        'wallet',
        provider:             pricing.provider,
        userPaid:             pricing.userPays,
        providerCost:         pricing.vasCost,
        ourMargin:            pricing.ourMargin,
        marginType:           'service_fee',
        pricingConfigVersion: pricingService.getConfigVersion(),
      }],
      { session }
    );

    await deductWalletBalance(user, pricing.userPays, session);
    await session.commitTransaction();
  } catch (dbErr) {
    await session.abortTransaction();
    console.error('[cac] register DB phase failed:', dbErr.message);
    return res.status(500).json({ success: false, message: 'Could not initiate registration. Please try again.' });
  } finally {
    session.endSession();
  }

  // ── Phase 2: submit to VAS ────────────────────────────────────────────────
  try {
    const vasResult = await cacVasService.registerBusinessName({
      registrationData: { ...registrationData, proposedName: String(proposedName).trim() },
      priorityService:  !!priorityService,
      transactionRef,
    });

    const vasTransactionRef = vasResult?.data?.transactionRef || vasResult?.transactionRef || null;
    await Promise.all([
      CACRegistration.findByIdAndUpdate(regDoc._id, { response: vasResult, ...(vasTransactionRef && { vasTransactionRef }) }),
      Transaction.findByIdAndUpdate(txDoc._id, { status: 'processing', response: vasResult }),
    ]);

    return res.status(202).json({
      success:         true,
      message:         'Registration submitted. You will be notified once CAC approves your application.',
      transactionRef,
      status:          'pending',
      userPaid:        pricing.userPays,
      priorityService: !!priorityService,
    });
  } catch (vasErr) {
    console.error('[cac] VAS submission failed:', vasErr.message);

    await refundWalletBalance(user, pricing.userPays).catch((e) =>
      console.error('[cac] Refund failed after VAS error:', e.message)
    );
    await Promise.all([
      CACRegistration.findByIdAndUpdate(regDoc._id, { status: 'failed' }).catch(() => {}),
      Transaction.findByIdAndUpdate(txDoc._id,      { status: 'failed', failureReason: vasErr.message }).catch(() => {}),
    ]);

    return res.status(vasErr.statusCode || 502).json({ success: false, message: vasErr.message });
  }
};

// ─── GET /api/cac/registration/:transactionRef ───────────────────────────────
const getRegistrationStatus = async (req, res) => {
  try {
    const { transactionRef } = req.params;

    const reg = await CACRegistration.findOne({ transactionRef }).lean();
    if (!reg) return res.status(404).json({ success: false, message: 'Registration not found.' });

    if (String(reg.userId) !== String(req.user.id) && !req.user.roles?.includes('admin')) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Poll VAS for any non-terminal status and sync result back to DB.
    // VAS generates its own ref (VAS...) returned at submission time; fall
    // back to our internal ref only if it was never stored (old records).
    const TERMINAL = ['approved', 'failed', 'cancelled'];
    if (!TERMINAL.includes(reg.status)) {
      try {
        const vasRef    = reg.vasTransactionRef || transactionRef;
        const vasResult = await cacVasService.checkRegistrationStatus({ transactionRef: vasRef });
        const vasData   = vasResult?.data || vasResult;
        const vasStatus = vasData?.status;
        const vasQueries = Array.isArray(vasData?.data) ? vasData.data : [];

        // Persist any status or query update so future loads reflect live VAS state
        const updates = {};
        if (vasStatus && vasStatus !== reg.status)   updates.status  = vasStatus;
        if (vasQueries.length > 0)                   updates.queries = vasQueries;
        if (Object.keys(updates).length > 0) {
          await CACRegistration.findByIdAndUpdate(reg._id, updates);
          Object.assign(reg, updates); // reflect in this response too
        }
      } catch {
        // VAS poll failure is non-fatal — return DB state
      }
    }

    return res.json({ success: true, registration: reg });
  } catch (err) {
    console.error('[cac] getRegistrationStatus error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not retrieve registration.' });
  }
};

// ─── POST /api/cac/registration/:transactionRef/resubmit ─────────────────────
// For queried registrations only. No additional charge.
const resubmitRegistration = async (req, res) => {
  try {
    const { transactionRef } = req.params;
    const { registrationData } = req.body;

    if (!registrationData) {
      return res.status(400).json({ success: false, message: 'registrationData is required.' });
    }

    const reg = await CACRegistration.findOne({ transactionRef });
    if (!reg) return res.status(404).json({ success: false, message: 'Registration not found.' });

    if (String(reg.userId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    if (reg.status !== 'queried') {
      return res.status(400).json({
        success: false,
        message: `Cannot resubmit a registration with status '${reg.status}'. Only queried registrations can be resubmitted.`,
      });
    }

    const vasResult = await cacVasService.registerBusinessName({
      registrationData: { ...registrationData, proposedName: reg.proposedName },
      priorityService:  reg.priorityService,
      transactionRef,
    });

    const vasTransactionRef = vasResult?.data?.transactionRef || vasResult?.transactionRef || null;
    reg.registrationData = registrationData;
    reg.status           = 'pending';
    reg.webhookReceived  = false;
    if (vasTransactionRef) reg.vasTransactionRef = vasTransactionRef;
    await reg.save();

    return res.json({ success: true, message: 'Resubmission successful. Awaiting CAC review.', transactionRef, vasStatus: vasResult });
  } catch (err) {
    console.error('[cac] resubmit error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── POST /api/cac/registration/:transactionRef/certificate ──────────────────
// Paid certificate download. verifyPin middleware runs before this handler.
const downloadCertificate = async (req, res) => {
  try {
    const { transactionRef } = req.params;

    const reg = await CACRegistration.findOne({ transactionRef }).lean();
    if (!reg) return res.status(404).json({ success: false, message: 'Registration not found.' });

    if (String(reg.userId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    if (reg.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Certificate is only available after CAC approval.' });
    }

    const pricing = pricingService.getCACPrice('bn_certificate');

    if (pricing.userPays > 0) {
      const user = await User.findById(req.user.id).select('+walletBalance');
      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

      if ((user.walletBalance || 0) < pricing.userPays) {
        return res.status(400).json({
          success: false,
          message: `Insufficient wallet balance. Required: ₦${pricing.userPays.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
        });
      }

      const txRef   = `cac-cert-${crypto.randomUUID()}`;
      const session = await mongoose.startSession();
      let txDoc;

      try {
        session.startTransaction();
        [txDoc] = await Transaction.create(
          [{
            userId:               req.user.id,
            amount:               pricing.userPays,
            reference:            txRef,
            status:               'pending',
            type:                 'cac_registration',
            paymentMethod:        'wallet',
            provider:             pricing.provider,
            userPaid:             pricing.userPays,
            providerCost:         pricing.vasCost,
            ourMargin:            pricing.ourMargin,
            marginType:           'service_fee',
            pricingConfigVersion: pricingService.getConfigVersion(),
          }],
          { session }
        );
        await deductWalletBalance(user, pricing.userPays, session);
        await session.commitTransaction();
      } catch (dbErr) {
        await session.abortTransaction();
        console.error('[cac] cert debit failed:', dbErr.message);
        return res.status(500).json({ success: false, message: 'Could not process certificate fee. Please try again.' });
      } finally {
        session.endSession();
      }

      try {
        // VAS needs the VAS-generated ref (VAS...), not our internal CACREG... ref
        const vasRef    = reg.vasTransactionRef || transactionRef;
        const vasResult = await cacVasService.downloadCertificate({ transactionRef: vasRef });
        await Transaction.findByIdAndUpdate(txDoc._id, { status: 'success' }).catch(() => {});
        const safeName = (reg.registrationData?.proposedOption1 || transactionRef).replace(/[^a-zA-Z0-9-_]/g, '_');
        res.set('Content-Type', vasResult.contentType);
        res.set('Content-Disposition', `attachment; filename="CAC-Certificate-${safeName}.pdf"`);
        return res.send(vasResult.buffer);
      } catch (vasErr) {
        await refundWalletBalance(user, pricing.userPays).catch(() => {});
        await Transaction.findByIdAndUpdate(txDoc._id, { status: 'failed', failureReason: vasErr.message }).catch(() => {});
        return res.status(vasErr.statusCode || 502).json({ success: false, message: vasErr.message });
      }
    }

    // pricing.userPays === 0 (free tier / future change)
    const vasRef    = reg.vasTransactionRef || transactionRef;
    const vasResult = await cacVasService.downloadCertificate({ transactionRef: vasRef });
    const safeName  = (reg.registrationData?.proposedOption1 || transactionRef).replace(/[^a-zA-Z0-9-_]/g, '_');
    res.set('Content-Type', vasResult.contentType);
    res.set('Content-Disposition', `attachment; filename="CAC-Certificate-${safeName}.pdf"`);
    return res.send(vasResult.buffer);

  } catch (err) {
    console.error('[cac] downloadCertificate error:', err.message);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/cac/search ─────────────────────────────────────────────────────
// Business validation. verifyPin middleware runs before this handler.
// Phase 1: atomic debit + records. Phase 2: VAS call (refund on failure).
const searchBusiness = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { validationType, searchParam } = req.body;

  if (!validationType || !searchParam) {
    return res.status(400).json({ success: false, message: 'validationType and searchParam are required.' });
  }

  const typeConfig = SEARCH_TYPES[validationType];
  if (!typeConfig) {
    return res.status(400).json({
      success: false,
      message: `Unknown validationType. Valid values: ${Object.keys(SEARCH_TYPES).join(', ')}`,
    });
  }

  const pricing = pricingService.getCACPrice(typeConfig.priceKey);

  let user;
  try {
    user = await User.findById(req.user.id).select('+walletBalance');
  } catch (dbErr) {
    console.error('[cac] searchBusiness user lookup failed:', dbErr.message);
    return res.status(500).json({ success: false, message: 'Could not retrieve user. Please try again.' });
  }
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  if ((user.walletBalance || 0) < pricing.userPays) {
    return res.status(400).json({
      success: false,
      message: `Insufficient wallet balance. Required: ₦${pricing.userPays.toLocaleString()}, Available: ₦${(user.walletBalance || 0).toLocaleString()}.`,
    });
  }

  const transactionRef = `CACVAL${Date.now()}`;
  const txRef          = `cac-val-${crypto.randomUUID()}`;

  // ── Phase 1: atomic debit + records ──────────────────────────────────────
  const session = await mongoose.startSession();
  let valDoc, txDoc;

  try {
    session.startTransaction();

    [valDoc] = await CACValidation.create(
      [{
        userId:                req.user.id,
        transactionRef,
        validationType,
        searchParam,
        userPaid:              pricing.userPays,
        vasCost:               pricing.vasCost,
        ourMargin:             pricing.ourMargin,
        billingTransactionRef: txRef,
      }],
      { session }
    );

    [txDoc] = await Transaction.create(
      [{
        userId:               req.user.id,
        amount:               pricing.userPays,
        reference:            txRef,
        status:               'pending',
        type:                 'cac_validation',
        paymentMethod:        'wallet',
        provider:             pricing.provider,
        userPaid:             pricing.userPays,
        providerCost:         pricing.vasCost,
        ourMargin:            pricing.ourMargin,
        marginType:           'service_fee',
        pricingConfigVersion: pricingService.getConfigVersion(),
      }],
      { session }
    );

    await deductWalletBalance(user, pricing.userPays, session);
    await session.commitTransaction();
  } catch (dbErr) {
    await session.abortTransaction();
    console.error('[cac] search DB phase failed:', dbErr.message);
    return res.status(500).json({ success: false, message: 'Could not initiate search. Please try again.' });
  } finally {
    session.endSession();
  }

  // ── Phase 2: call VAS ─────────────────────────────────────────────────────
  try {
    const vasResult = await typeConfig.call(String(searchParam).trim());

    await Promise.all([
      CACValidation.findByIdAndUpdate(valDoc._id, { result: vasResult }).catch(() => {}),
      Transaction.findByIdAndUpdate(txDoc._id,    { status: 'success', response: vasResult }).catch(() => {}),
    ]);

    return res.json({
      success:       true,
      transactionRef,
      validationType,
      userPaid:      pricing.userPays,
      data:          vasResult,
    });
  } catch (vasErr) {
    console.error('[cac] search VAS call failed:', vasErr.message);

    await refundWalletBalance(user, pricing.userPays).catch(() => {});
    await Transaction.findByIdAndUpdate(txDoc._id, { status: 'failed', failureReason: vasErr.message }).catch(() => {});

    return res.status(vasErr.statusCode || 502).json({ success: false, message: vasErr.message });
  }
};

// ─── GET /api/cac/history ─────────────────────────────────────────────────────
const getHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit  = Math.min(parseInt(req.query.limit || '20', 10), 50);
    const skip   = parseInt(req.query.skip   || '0',  10);

    const [registrations, validations] = await Promise.all([
      CACRegistration.find({ userId }).sort({ createdAt: -1 }).limit(limit).skip(skip).lean(),
      CACValidation.find({ userId }).sort({ createdAt: -1 }).limit(limit).skip(skip).lean(),
    ]);

    return res.json({ success: true, registrations, validations });
  } catch (err) {
    console.error('[cac] getHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not retrieve history.' });
  }
};

// ─── POST /api/cac/register/llc ──────────────────────────────────────────────
// Out of scope — stub only.
const registerLLC = (_req, res) =>
  res.status(501).json({
    success: false,
    message: 'LLC Company Registration is not yet available. Please check back soon.',
  });

// ─── POST /api/cac/webhook ────────────────────────────────────────────────────
// Inbound VAS webhook — no JWT auth.
// HMAC-SHA256 verification (CAC_VAS_WEBHOOK_SECRET + x-vas-signature header).
// Idempotency: CACRegistration.webhookReceived flag.
const handleWebhook = async (req, res) => {
  try {
    const rawBody = req.body; // express.raw() puts a Buffer here
    const sig     = req.headers['x-vas-signature'] || '';

    if (!verifyWebhookSig(rawBody, sig)) {
      console.warn('[cac] Webhook rejected — signature mismatch');
      return res.status(401).json({ success: false, message: 'Invalid signature.' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid JSON payload.' });
    }

    const { transactionRef, status, rcNumber, tin, certificateUrl, queries } = payload;

    if (!transactionRef) {
      return res.status(400).json({ success: false, message: 'transactionRef is required.' });
    }

    const reg = await CACRegistration.findOne({ transactionRef });
    if (!reg) {
      console.warn(`[cac] Webhook for unknown transactionRef: ${transactionRef}`);
      return res.status(404).json({ success: false, message: 'Registration not found.' });
    }

    // Idempotency guard
    if (reg.webhookReceived) {
      console.log(`[cac] Duplicate webhook for ${transactionRef} — ignoring`);
      return res.status(200).json({ success: true, message: 'Already processed.' });
    }

    reg.webhookReceived   = true;
    reg.webhookReceivedAt = new Date();

    if (status === 'approved') {
      reg.status         = 'approved';
      if (rcNumber)       reg.rcNumber       = rcNumber;
      if (tin)            reg.tin            = tin;
      if (certificateUrl) reg.certificateUrl = certificateUrl;
    } else if (status === 'queried') {
      reg.status = 'queried';
      if (Array.isArray(queries) && queries.length > 0) {
        reg.queries.push(...queries);
      }
    } else if (status === 'failed') {
      reg.status = 'failed';
    } else {
      console.warn(`[cac] Unknown webhook status '${status}' for ${transactionRef}`);
    }

    await reg.save();
    console.log(`[cac] Webhook processed: ${transactionRef} → ${reg.status}`);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[cac] handleWebhook error:', err.message);
    return res.status(500).json({ success: false, message: 'Webhook processing error.' });
  }
};

// ─── POST /api/cac/compliance ─────────────────────────────────────────────────
// Free BN compliance pre-check (no wallet deduction).
// Returns statusCode, message, recommendedActions, suggestedNames, similarNames.
const checkCompliance = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { proposedName, lineOfBusiness } = req.body;
  if (!proposedName || !String(proposedName).trim()) {
    return res.status(400).json({ success: false, message: 'proposedName is required.' });
  }

  try {
    const vasResult = await cacVasService.bnCompliance({
      proposedName:   String(proposedName).trim(),
      lineOfBusiness: lineOfBusiness ? String(lineOfBusiness).trim() : '',
    });
    return res.json({ success: true, data: vasResult });
  } catch (err) {
    console.error('[cac] checkCompliance error:', err.message);

    // 403 from VAS = compliance endpoint not enabled for this API key.
    // Return 200 with a structured not-available response so the frontend
    // can degrade gracefully — compliance check is optional, not a blocker.
    if (err.statusCode === 403 || err.response?.status === 403) {
      return res.json({
        success: true,
        unavailable: true,
        message: 'Compliance check is not enabled for your VAS account. Please contact your VAS provider to activate this feature. You can still proceed with registration.',
      });
    }

    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── POST /api/cac/validate ──────────────────────────────────────────────────
// Validate text fields in the registration payload before wallet deduction.
// Document presence is enforced client-side; this endpoint only validates
// text fields via the free VAS pre-check API.
const IMAGE_FIELDS = ['passport', 'meansOfId', 'signature', 'supportingDoc',
                      'proprietorProofOfAddress', 'businessProofOfAddress'];

const validatePayload = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const payload = { ...req.body };

  // Strip base64 images — never forward to VAS logs
  IMAGE_FIELDS.forEach(f => delete payload[f]);

  try {
    const vasResult = await cacVasService.validateBnPayload(payload);
    return res.json({ success: true, data: vasResult });
  } catch (err) {
    console.error('[cac] validatePayload error:', err.message);

    // 403 from VAS = pre-validation endpoint not enabled for this API key.
    // Degrade gracefully — pre-check is optional, not a blocker.
    if (err.statusCode === 403 || err.response?.status === 403) {
      return res.json({
        success:     true,
        unavailable: true,
        message:     'Pre-validation is not available for your VAS account. You can still proceed — your registration will be validated by CAC during processing.',
      });
    }

    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  getPrices,
  validateName,
  registerBusinessName,
  getRegistrationStatus,
  resubmitRegistration,
  downloadCertificate,
  searchBusiness,
  getHistory,
  registerLLC,
  handleWebhook,
  checkCompliance,
  validatePayload,
};
