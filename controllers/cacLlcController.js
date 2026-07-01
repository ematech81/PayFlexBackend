'use strict';

const CacLlcSession   = require('../models/CacLlcSession');
const CacLlcAffiliate = require('../models/CacLlcAffiliate');
const Transaction     = require('../models/transaction');
const User            = require('../models/user');
const cacLlcVas       = require('../services/cacLlcVasService');
const { deductWalletBalance, refundWalletBalance } = require('../util/paymentHelper');

const featureEnabled = () => process.env.FEATURE_CAC_ENABLED !== 'false';

// CAC statutory fee: ₦1,000 base + 1% of share capital (minimum ₦10,000 rate)
const calcLlcFee = (shareCapital) => {
  const rate = Math.max(10_000, Math.floor(Number(shareCapital || 0) / 100));
  return 1_000 + rate;
};

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

    // VAS response: { data: { success: { companyTypes, shareInfo: { data: { minimumShareCapital } } } } }
    const inner           = vasResult?.data?.success || vasResult?.data || vasResult;
    const minShareCapital = inner?.shareInfo?.data?.minimumShareCapital
                         ?? inner?.shareInfo?.minimumShareCapital
                         ?? null;

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
    const cleanObjects = (objectsOfMem || session.objectsOfMem || []).filter(o => typeof o === 'string' && o.trim());

    // VAS requires local Nigerian format (10–15 digits, no +234 prefix)
    let normalizedPhone = String(phoneNumber || '').replace(/\s+/g, '');
    if (normalizedPhone.startsWith('+234')) {
      normalizedPhone = '0' + normalizedPhone.slice(4);
    } else if (/^234\d{9,10}$/.test(normalizedPhone)) {
      normalizedPhone = '0' + normalizedPhone.slice(3);
    }

    // VAS /nob/categories returns names with semicolons like
    // "WHOLESALE AND RETAIL TRADE;REPAIR OF MOTOR VEHICLES..." but its /company
    // endpoint rejects semicolons as "security restricted character". Strip the
    // semicolon and everything after it — VAS expects just the primary category.
    const cleanCategory = (natureOfBusinessCategory || '').split(';')[0].trim();

    // VAS /company endpoint also rejects strings with trailing periods returned
    // by its own /nob/:id endpoint. Strip the trailing period.
    const cleanNatureOfBusiness = (natureOfBusiness || '').trim().replace(/\.$/, '');

    const createPayload = {
      reservationCode:         session.reservationCode,
      companyType:             session.companyType,
      natureOfBusinessCategory: cleanCategory,
      natureOfBusiness: cleanNatureOfBusiness,
      principalActivityDescription,
      companyEmail,
      phoneNumber:             normalizedPhone,
      companyAddress,
      objectsOfMem: cleanObjects,
    };
    console.log('[cac-llc] createCompany VAS payload (full):', JSON.stringify(createPayload, null, 2));

    const vasResult = await cacLlcVas.createCompany(createPayload);

    const vasTransactionRef = vasResult?.data?.transactionRef || vasResult?.transactionRef;
    if (!vasTransactionRef) {
      return res.status(502).json({
        success: false,
        message: vasResult?.message || 'Company creation failed — no transaction ref returned.',
      });
    }

    const regAddr = companyAddress?.registeredAddress || {};
    const hoAddr  = companyAddress?.headOffice        || {};
    await CacLlcSession.findByIdAndUpdate(sessionId, {
      vasTransactionRef,
      natureOfBusinessCategory,
      natureOfBusiness,
      principalActivityDescription,
      companyEmail,
      companyPhone:        normalizedPhone,
      registeredAddress:   regAddr,
      headOfficeAddress:   hoAddr,
      headOfficeSameAsReg: !companyAddress?.headOffice,
      companyDetails:      vasResult,
      objectsOfMem:        objectsOfMem || session.objectsOfMem,
      status:              'company_created',
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

  // Rule 5: enforce minimumShareCapital from Step 3 analysis.
  // VAS AI occasionally returns wildly inflated minimums (e.g. 50B for banking licence)
  // even for standard wholesale/retail companies. Cap enforcement at 2B so normal SMEs
  // aren't blocked by an AI classification error. VAS itself validates share capital
  // server-side; we just want to catch obvious user mistakes.
  const enforceableMinimum = (session.minimumShareCapital && session.minimumShareCapital <= 2_000_000_000)
    ? session.minimumShareCapital
    : null;
  if (enforceableMinimum && shareCapital < enforceableMinimum) {
    return res.status(400).json({
      success: false,
      message: `Share capital (₦${shareCapital.toLocaleString()}) is below the minimum required ₦${enforceableMinimum.toLocaleString()} for your business activity (Rule 5).`,
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
    // Map frontend field names → VAS field names and normalise address shape
    const mapAddr = (a) => ({
      country:    'Nigeria',
      state:      a?.state    || '',
      lga:        a?.lga      || '',
      city:       a?.city     || '',
      streetInfo: a?.street   || a?.streetInfo || '',
    });
    const affiliateTypeArr = Array.isArray(affiliateType) ? affiliateType : [affiliateType];

    let vasAffiliate;
    if (affiliateMode === 'individual') {
      vasAffiliate = {
        surname:            affiliateData.surname,
        firstname:          affiliateData.firstname,
        otherName:          affiliateData.othername   || affiliateData.otherName || '',
        occupation:         affiliateData.occupation  || '',
        nationality:        affiliateData.nationality || 'Nigerian',
        dob:                affiliateData.dob,
        gender:             affiliateData.gender,
        email:              affiliateData.email,
        phoneNumber:        affiliateData.phone       || affiliateData.phoneNumber,
        affiliateType:      affiliateTypeArr,
        serviceAddress:     mapAddr(affiliateData.serviceAddress),
        residentialAddress: mapAddr(affiliateData.residentialAddress),
        meansOfId:          affiliateData.meansOfId,
        signature:          affiliateData.signature,
        passport:           affiliateData.passport,
        isShareholder,
        ...(isShareholder && shareAllotment && { shareAllotment }),
      };
    } else {
      vasAffiliate = {
        isForeign:          affiliateData.isForeign          || false,
        isGovernmentAgency: affiliateData.isGovernmentAgency || false,
        rcNumber:           affiliateData.rcNumber,
        companyName:        affiliateData.companyName,
        contactPhoneNumber: affiliateData.contactPhone       || affiliateData.contactPhoneNumber,
        contactEmail:       affiliateData.contactEmail,
        contactSignature:   affiliateData.signature          || affiliateData.contactSignature,
        affiliateType:      affiliateTypeArr,
        serviceAddress:     mapAddr(affiliateData.serviceAddress),
        isShareholder,
        ...(isShareholder && shareAllotment && { shareAllotment }),
      };
    }

    const vasResult = await cacLlcVas.registerAffiliate({
      transactionRef: session.vasTransactionRef,
      affiliateMode,
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

    const affiliateKey = vasResult?.data?.affiliateKey || null;

    return res.json({
      success:        true,
      affiliateId:    affiliateDoc._id,
      affiliateKey,
      totalAllocated: newTotalAlloc,
      sharesRemaining,
      sharesBalanced,
      message: sharesBalanced
        ? 'Affiliate registered. All shares are now allocated. Proceed to Step 7 (PSC registration).'
        : `Affiliate registered. ${sharesRemaining.toLocaleString()} shares still unallocated.`,
    });
  } catch (err) {
    console.error('[cac-llc] registerAffiliate error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── Step 7: POST /api/cac/llc/psc ──────────────────────────────────────────
const registerPsc = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const {
    sessionId, affiliateKey,
    ownsDirectShares = true, directShareDetails,
    ownsIndirectShares = false, indirectShareDetails,
    isPep = false, isPscAffiliated = false,
    canChangeDirectors = true, hasSignificantControlOfCompany = true,
  } = req.body;

  if (!sessionId)    return res.status(400).json({ success: false, message: 'sessionId is required.' });
  if (!affiliateKey) return res.status(400).json({ success: false, message: 'affiliateKey is required.' });

  const session = await CacLlcSession.findOne({ _id: sessionId, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });
  if (!['affiliates_complete', 'psc_registered'].includes(session.status)) {
    return res.status(400).json({
      success: false,
      message: `All shares must be allocated before registering PSC. Current status: ${session.status}`,
    });
  }

  try {
    const vasResult = await cacLlcVas.registerPsc({
      transactionRef: session.vasTransactionRef,
      affiliateKey,
      ownsDirectShares, directShareDetails,
      ownsIndirectShares, indirectShareDetails,
      isPep, isPscAffiliated, canChangeDirectors, hasSignificantControlOfCompany,
    });

    console.log('[cac-llc] registerPsc VAS response:', JSON.stringify(vasResult).substring(0, 300));

    const pscKey = vasResult?.data?.affiliateKey || null;

    await CacLlcSession.findByIdAndUpdate(sessionId, { status: 'psc_registered' });

    return res.json({
      success: true,
      pscKey,
      message: vasResult?.message || 'PSC registered successfully.',
    });
  } catch (err) {
    console.error('[cac-llc] registerPsc error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── Step 8: POST /api/cac/llc/submit ────────────────────────────────────────
const submitRegistration = async (req, res) => {
  if (!featureEnabled()) {
    return res.status(503).json({ success: false, message: 'CAC services are temporarily unavailable.' });
  }

  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId is required.' });

  const session = await CacLlcSession.findOne({ _id: sessionId, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });
  if (!['psc_registered'].includes(session.status)) {
    return res.status(400).json({
      success: false,
      message: `PSC must be registered before submitting. Current status: ${session.status}`,
    });
  }
  if (!session.vasTransactionRef) {
    return res.status(400).json({ success: false, message: 'No VAS transaction reference found. Please restart the registration.' });
  }

  const fee = calcLlcFee(session.shareCapital || 0);

  const user = await User.findById(req.user.id).select('+walletBalance');
  if ((user.walletBalance || 0) < fee) {
    return res.status(400).json({
      success: false,
      message: `Insufficient wallet balance. Registration fee is ₦${fee.toLocaleString()}. Your balance is ₦${(user.walletBalance || 0).toLocaleString()}.`,
    });
  }

  const ref = `LLC-REG-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
  const txn = await Transaction.create({
    userId:    user._id,
    amount:    fee,
    type:      'cac_registration',
    status:    'pending',
    reference: ref,
    metadata:  { sessionId: String(session._id), vasTransactionRef: session.vasTransactionRef },
  });

  await deductWalletBalance(user, fee);

  try {
    const vasResult = await cacLlcVas.submitRegistration({ transactionRef: session.vasTransactionRef });
    console.log('[cac-llc] submitRegistration VAS response:', JSON.stringify(vasResult).substring(0, 500));

    const actualFee    = vasResult?.statutoryPayment?.statutoryFee || fee;
    const vasRegId     = vasResult?.id || null;
    const regStatus    = vasResult?.metrics?.status || 'PENDING';
    const companyName  = vasResult?.registration?.proposedName || session.companyName || '';

    // Refund the difference if VAS charged less than we estimated
    if (actualFee < fee) {
      const diff = fee - actualFee;
      await refundWalletBalance(user, diff).catch(() => {});
      await Transaction.findByIdAndUpdate(txn._id, { amount: actualFee, status: 'success' });
    } else {
      await Transaction.findByIdAndUpdate(txn._id, { status: 'success' });
    }

    await CacLlcSession.findByIdAndUpdate(sessionId, {
      status:            'submitted',
      vasRegistrationId: vasRegId,
      companyName,
      vasStatus:         regStatus,
      submittedAt:       new Date(),
    });

    return res.json({
      success:            true,
      vasRegistrationId:  vasRegId,
      transactionRef:     session.vasTransactionRef,
      companyName,
      status:             regStatus,
      statutoryFee:       actualFee,
      newBalance:         user.walletBalance,
      message:            'Company registration submitted successfully. Status: PENDING review by CAC.',
    });
  } catch (err) {
    await refundWalletBalance(user, fee).catch(() => {});
    await Transaction.findByIdAndUpdate(txn._id, { status: 'failed' }).catch(() => {});
    console.error('[cac-llc] submitRegistration error:', err.message);
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

// ─── GET /api/cac/llc/registration/:sessionId/status ─────────────────────────
// Polls VAS for the live registration status (PENDING / QUERIED / APPROVED).
// Only meaningful after Step 8 (submit) when vasTransactionRef exists.
const getRegistrationStatus = async (req, res) => {
  try {
    const session = await CacLlcSession.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ success: false, message: 'LLC session not found.' });
    if (String(session.userId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    if (!session.vasTransactionRef) {
      return res.status(400).json({ success: false, message: 'Registration has not reached the company-creation step yet.' });
    }

    const raw    = await cacLlcVas.getRegistrationStatus(session.vasTransactionRef);
    const data   = raw?.data || raw;
    const status = data?.status || 'PENDING';

    // Persist the latest VAS status back to our session record
    const update = { vasStatus: status };
    if (status === 'QUERIED') update.vasQueryReasons = data;
    if (status === 'APPROVED') update.status = 'approved';
    await CacLlcSession.findByIdAndUpdate(session._id, update);

    return res.json({ success: true, status, data });
  } catch (err) {
    console.error('[cac-llc] getRegistrationStatus error:', err.message);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── GET /api/cac/llc/vas-categories ─────────────────────────────────────────
const getVasCategories = async (req, res) => {
  try {
    const data = await cacLlcVas.getNatureOfBusinessCategories();
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[cac-llc] getVasCategories error:', err.message, err.response?.status);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

// ─── GET /api/cac/llc/nob/:categoryId ────────────────────────────────────────
const getVasNatureOfBusiness = async (req, res) => {
  try {
    const raw   = await cacLlcVas.getNatureOfBusiness(req.params.categoryId);
    const items = (raw?.data || []).filter(Boolean);
    return res.json({ success: true, data: items });
  } catch (err) {
    console.error('[cac-llc] getVasNatureOfBusiness error:', err.message, err.response?.status);
    return res.status(err.statusCode || 502).json({ success: false, message: err.message });
  }
};

module.exports = {
  nameReservation,
  generateMemoObjects,
  analyseMemoObjects,
  createCompany,
  registerShares,
  registerAffiliate,
  registerPsc,
  submitRegistration,
  getLlcSession,
  getLlcHistory,
  getRegistrationStatus,
  getVasCategories,
  getVasNatureOfBusiness,
};
