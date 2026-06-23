'use strict';

const CacLlcSession   = require('../models/CacLlcSession');
const CacLlcAffiliate = require('../models/CacLlcAffiliate');
const cacLlcVas       = require('../services/cacLlcVasService');

const featureEnabled = () => process.env.FEATURE_CAC_ENABLED !== 'false';

const VALID_COMPANY_TYPES = [
  'PRIVATE_COMPANY_LIMITED_BY_SHARES',
  'PRIVATE_UNLIMITED_COMPANY',
  'PUBLIC_COMPANY_LIMITED_BY_SHARES',
  'PUBLIC_UNLIMITED_COMPANY',
];

const IMAGE_FIELDS = ['passport', 'meansOfId', 'signature', 'supportingDoc'];

// Strip base64 image fields before persisting affiliate data
function _stripImages(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  IMAGE_FIELDS.forEach(f => delete out[f]);
  return out;
}

// ─── Step 1: POST /api/cac/llc/name-reservation ──────────────────────────────
const nameReservation = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { proposedName, companyType } = req.body;
  if (!proposedName?.trim()) {
    return res.status(400).json({ success: false, message: 'proposedName is required.' });
  }
  if (!companyType) {
    return res.status(400).json({ success: false, message: 'companyType is required.' });
  }
  if (!VALID_COMPANY_TYPES.includes(companyType)) {
    return res.status(400).json({
      success: false,
      message: `companyType must be one of: ${VALID_COMPANY_TYPES.join(', ')}`,
    });
  }

  const cleanName = proposedName.trim().toUpperCase();

  // Check for an existing non-cancelled session for this user + name first.
  // This lets users resume mid-registration without re-calling VAS.
  try {
    const existing = await CacLlcSession.findOne({
      userId:       req.user.id,
      proposedName: cleanName,
      status:       { $nin: ['failed', 'cancelled'] },
    }).sort({ createdAt: -1 });

    if (existing) {
      const now     = new Date();
      const expired = existing.reservationExpiry && existing.reservationExpiry < now;
      if (expired) {
        return res.status(400).json({
          success: false,
          expired: true,
          message: `Your reservation for "${cleanName}" expired on ${existing.reservationExpiry.toLocaleDateString('en-NG')}. Please reserve the name again to continue.`,
        });
      }
      // Active session found — return it so the frontend can jump to the right step.
      return res.json({
        success:         true,
        resumed:         true,
        sessionId:       existing._id,
        reservationCode: existing.reservationCode,
        expiryDate:      existing.reservationExpiry,
        proposedName:    existing.proposedName,
        companyType:     existing.companyType,
        currentStatus:   existing.status,
        message:         'Resuming your existing registration session.',
      });
    }
  } catch (dbErr) {
    console.error('[cac-llc] nameReservation session lookup error:', dbErr.message);
    // Non-fatal — fall through to VAS call
  }

  try {
    const vasResult = await cacLlcVas.reserveName({
      proposedName: cleanName,
      companyTypes: companyType,
    });

    const vasData = vasResult?.data || vasResult;
    const { reservationCode, expiryDate } = vasData || {};

    if (!reservationCode) {
      return res.status(502).json({
        success: false,
        message: vasResult?.message || 'Name reservation failed — no reservation code returned.',
      });
    }

    const session = await CacLlcSession.create({
      userId:            req.user.id,
      proposedName:      cleanName,
      companyType,
      reservationCode,
      reservationExpiry: expiryDate ? new Date(expiryDate) : null,
      status:            'name_reserved',
    });

    return res.status(201).json({
      success:         true,
      sessionId:       session._id,
      reservationCode,
      expiryDate,
      proposedName:    session.proposedName,
    });
  } catch (err) {
    console.error('[cac-llc] nameReservation error:', err.message, err.vasRaw ? JSON.stringify(err.vasRaw).substring(0, 300) : '');
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── Step 2: POST /api/cac/llc/memorandum/generate ───────────────────────────
const generateMemoObjects = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { sessionId, countOfObjects = 5, natureOfBusiness } = req.body;
  if (!sessionId)        return res.status(400).json({ success: false, message: 'sessionId is required.' });
  if (!natureOfBusiness) return res.status(400).json({ success: false, message: 'natureOfBusiness is required.' });

  const session = await CacLlcSession.findOne({ _id: sessionId, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });
  if (['failed', 'cancelled'].includes(session.status)) {
    return res.status(400).json({ success: false, message: `Session is ${session.status} and cannot be continued.` });
  }

  try {
    const vasResult = await cacLlcVas.generateMemoObjects({ countOfObjects, natureOfBusiness });

    // VAS may return the objects under different shapes — handle all known variants:
    //   { data: ["obj1", "obj2"] }           → data is the array directly
    //   { data: { objectsOfMem: [...] } }    → nested under objectsOfMem
    //   { objectsOfMem: [...] }              → at root
    console.log('[cac-llc] generateMemoObjects raw VAS response:', JSON.stringify(vasResult).substring(0, 600));
    // VAS wraps response as { data: { data: { objectsOfMem, shareInfo } } }
    const inner   = vasResult?.data?.data || vasResult?.data || vasResult;
    const objects = Array.isArray(inner)
      ? inner
      : (inner?.objectsOfMem || []);
    const shareInfo = inner?.shareInfo || null;

    return res.json({ success: true, objectsOfMem: objects, shareInfo });
  } catch (err) {
    console.error('[cac-llc] generateMemoObjects error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── Step 3: POST /api/cac/llc/memorandum/analyse ────────────────────────────
const analyseMemoObjects = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { sessionId, objects } = req.body;
  if (!sessionId)       return res.status(400).json({ success: false, message: 'sessionId is required.' });
  if (!objects?.length) return res.status(400).json({ success: false, message: 'objects array is required.' });

  const session = await CacLlcSession.findOne({ _id: sessionId, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });

  try {
    const vasResult = await cacLlcVas.analyseMemoObjects({ objects });
    console.log('[cac-llc] analyseMemoObjects raw VAS response:', JSON.stringify(vasResult).substring(0, 600));

    // Same double-nested shape as generate-objects: { data: { data: { shareInfo, ... } } }
    const inner          = vasResult?.data?.data || vasResult?.data || vasResult;
    const minShareCapital = inner?.shareInfo?.minimumShareCapital ?? null;

    await CacLlcSession.findByIdAndUpdate(sessionId, {
      objectsOfMem:     objects,
      objectsAnalysed:  true,
      analysisResult:   inner,
      status:           'memorandum_done',
      ...(minShareCapital !== null && { minimumShareCapital: minShareCapital }),
    });

    return res.json({ success: true, minimumShareCapital: minShareCapital, analysisResult: inner });
  } catch (err) {
    console.error('[cac-llc] analyseMemoObjects error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── Step 4: POST /api/cac/llc/company ───────────────────────────────────────
const createCompany = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const {
    sessionId, natureOfBusinessCategory, natureOfBusiness,
    principalActivityDescription, companyEmail, phoneNumber,
    companyAddress, objectsOfMem,
  } = req.body;

  if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId is required.' });

  const reqFields = { natureOfBusinessCategory, natureOfBusiness, principalActivityDescription, companyEmail, phoneNumber };
  const missing   = Object.entries(reqFields).filter(([, v]) => !v?.toString().trim()).map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
  }
  if (!companyAddress?.registeredAddress?.state) {
    return res.status(400).json({ success: false, message: 'companyAddress.registeredAddress is required.' });
  }

  const session = await CacLlcSession.findOne({ _id: sessionId, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });
  if (!['name_reserved', 'memorandum_done'].includes(session.status)) {
    return res.status(400).json({
      success: false,
      message: `Company already created for this session (status: ${session.status}).`,
    });
  }
  if (!session.reservationCode) {
    return res.status(400).json({ success: false, message: 'Name must be reserved first (Rule 1).' });
  }

  try {
    const vasResult = await cacLlcVas.createCompany({
      reservationCode:          session.reservationCode,
      companyType:              session.companyType,
      natureOfBusinessCategory,
      natureOfBusiness,
      principalActivityDescription,
      companyEmail,
      phoneNumber,
      companyAddress,
      objectsOfMem: objectsOfMem || session.objectsOfMem,
    });

    const vasTransactionRef = vasResult?.data?.transactionRef || vasResult?.transactionRef;
    if (!vasTransactionRef) {
      return res.status(502).json({
        success: false,
        message: vasResult?.message || 'Company creation failed — no transaction ref returned.',
      });
    }

    await CacLlcSession.findByIdAndUpdate(sessionId, {
      vasTransactionRef,
      natureOfBusinessCategory,
      natureOfBusiness,
      companyDetails: vasResult,
      objectsOfMem:   objectsOfMem || session.objectsOfMem,
      status:         'company_created',
    });

    return res.json({
      success:          true,
      vasTransactionRef,
      message:          'Company created. Proceed to register shares.',
    });
  } catch (err) {
    console.error('[cac-llc] createCompany error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── Step 5: POST /api/cac/llc/shares ────────────────────────────────────────
const registerShares = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { sessionId, ordinaryIssuedShare, pricePerShare = 1, preferenceIssuedShare = 0 } = req.body;

  if (!sessionId)           return res.status(400).json({ success: false, message: 'sessionId is required.' });
  if (!ordinaryIssuedShare) return res.status(400).json({ success: false, message: 'ordinaryIssuedShare is required.' });

  const session = await CacLlcSession.findOne({ _id: sessionId, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });
  if (session.status !== 'company_created') {
    return res.status(400).json({
      success: false,
      message: `Company must be created before registering shares (Rule 2). Current status: ${session.status}`,
    });
  }

  const shareCapital = (Number(ordinaryIssuedShare) * Number(pricePerShare))
                     + (Number(preferenceIssuedShare) * Number(pricePerShare));

  // Rule 5: enforce minimumShareCapital from Step 3 analysis
  if (session.minimumShareCapital && shareCapital < session.minimumShareCapital) {
    return res.status(400).json({
      success: false,
      message: `Share capital (₦${shareCapital.toLocaleString()}) is below the minimum required ₦${session.minimumShareCapital.toLocaleString()} for your business activity (Rule 5).`,
    });
  }

  try {
    const vasResult = await cacLlcVas.registerShares({
      transactionRef:        session.vasTransactionRef,
      ordinaryIssuedShare:   Number(ordinaryIssuedShare),
      pricePerShare:         Number(pricePerShare),
      preferenceIssuedShare: Number(preferenceIssuedShare),
    });

    await CacLlcSession.findByIdAndUpdate(sessionId, {
      ordinaryIssuedShare:   Number(ordinaryIssuedShare),
      pricePerShare:         Number(pricePerShare),
      preferenceIssuedShare: Number(preferenceIssuedShare),
      shareCapital,
      sharesRegistered: true,
      status:           'shares_registered',
    });

    return res.json({
      success:      true,
      shareCapital,
      message:      'Shares registered. Proceed to add affiliates.',
    });
  } catch (err) {
    console.error('[cac-llc] registerShares error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── Step 6: POST /api/cac/llc/affiliate ─────────────────────────────────────
const registerAffiliate = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const {
    sessionId, affiliateType, affiliateMode = 'individual',
    isShareholder = false, shareAllotment, affiliateData,
  } = req.body;

  if (!sessionId)     return res.status(400).json({ success: false, message: 'sessionId is required.' });
  if (!affiliateType) return res.status(400).json({ success: false, message: 'affiliateType is required.' });
  if (!affiliateData) return res.status(400).json({ success: false, message: 'affiliateData is required.' });

  const session = await CacLlcSession.findOne({ _id: sessionId, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });
  if (!['shares_registered', 'affiliates_complete'].includes(session.status)) {
    return res.status(400).json({
      success: false,
      message: `Shares must be registered before adding affiliates (Rule 3). Current status: ${session.status}`,
    });
  }

  // Rule 4: share allotment must not exceed total registered shares
  if (isShareholder && shareAllotment) {
    const newTotal = session.totalAllocatedOrdinaryShares + (shareAllotment.allottedOrdinaryShares || 0);
    if (newTotal > session.ordinaryIssuedShare) {
      return res.status(400).json({
        success: false,
        message: `Adding this allotment (${shareAllotment.allottedOrdinaryShares}) would exceed the registered ordinary shares (${session.ordinaryIssuedShare}). Currently allocated: ${session.totalAllocatedOrdinaryShares} (Rule 4).`,
      });
    }
  }

  try {
    const vasAffiliate = {
      ...affiliateData,
      affiliateType,
      isShareholder,
      ...(isShareholder && shareAllotment && { shareAllotment }),
    };

    const vasResult = await cacLlcVas.registerAffiliate({
      transactionRef: session.vasTransactionRef,
      affiliate:      vasAffiliate,
    });

    const affiliateDoc = await CacLlcAffiliate.create({
      userId:         req.user.id,
      sessionId:      session._id,
      affiliateType,
      affiliateMode,
      isShareholder,
      shareAllotment: isShareholder ? shareAllotment : undefined,
      affiliateData:  _stripImages(affiliateData),
      vasResponse:    vasResult,
      status:         'registered',
    });

    const allotmentDelta   = isShareholder ? (shareAllotment?.allottedOrdinaryShares || 0) : 0;
    const newTotalAlloc    = session.totalAllocatedOrdinaryShares + allotmentDelta;
    const newCount         = session.affiliateCount + 1;
    const sharesBalanced   = newTotalAlloc === session.ordinaryIssuedShare;
    const sharesRemaining  = session.ordinaryIssuedShare - newTotalAlloc;

    await CacLlcSession.findByIdAndUpdate(sessionId, {
      affiliateCount:               newCount,
      totalAllocatedOrdinaryShares: newTotalAlloc,
      // Only mark affiliates_complete when all shares are allocated
      status: sharesBalanced ? 'affiliates_complete' : 'shares_registered',
    });

    return res.json({
      success:         true,
      affiliateId:     affiliateDoc._id,
      totalAllocated:  newTotalAlloc,
      sharesRemaining,
      sharesBalanced,
      // TODO Step 7: Register PSC — pending docs
      // TODO Step 8: Validate, Pay and Submit — pending docs
      message: sharesBalanced
        ? 'Affiliate registered. All shares are now allocated. Steps 7–8 (PSC & submission) coming soon.'
        : `Affiliate registered. ${sharesRemaining.toLocaleString()} shares still unallocated.`,
    });
  } catch (err) {
    console.error('[cac-llc] registerAffiliate error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── GET /api/cac/llc/registration/:sessionId ────────────────────────────────
const getLlcSession = async (req, res) => {
  try {
    const session = await CacLlcSession.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });
    if (String(session.userId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const affiliates = await CacLlcAffiliate.find({ sessionId: session._id }).lean();
    return res.json({ success: true, session, affiliates });
  } catch (err) {
    console.error('[cac-llc] getLlcSession error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not retrieve LLC session.' });
  }
};

// ─── GET /api/cac/llc/history ─────────────────────────────────────────────────
const getLlcHistory = async (req, res) => {
  try {
    const sessions = await CacLlcSession
      .find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, sessions });
  } catch (err) {
    console.error('[cac-llc] getLlcHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not retrieve LLC history.' });
  }
};

module.exports = {
  nameReservation,
  generateMemoObjects,
  analyseMemoObjects,
  createCompany,
  registerShares,
  registerAffiliate,
  getLlcSession,
  getLlcHistory,
};
