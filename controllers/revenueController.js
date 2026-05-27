'use strict';

const Transaction        = require('../models/transaction');
const BettingTransaction = require('../models/BettingTransaction');
const ExamPinTransaction = require('../models/ExamPinTransaction');
const User               = require('../models/user');

// ─── Constants ────────────────────────────────────────────────────────────────

// Transaction collection uses 'success' OR 'completed' for fulfilled payments
const TX_SUCCESS  = { $in: ['success', 'completed'] };
// VTU Africa collections use only 'success'
const VTU_SUCCESS = 'success';

// Reusable $group accumulator — all three collections share these field names
const ACCUM = {
  count:               { $sum: 1 },
  totalUserPaid:       { $sum: '$userPaid' },
  totalProviderCost:   { $sum: '$providerCost' },
  totalOurMargin:      { $sum: '$ourMargin' },
  totalRecipientFee:   { $sum: '$recipientFee' },
  totalCommission:     { $sum: '$vtuAfricaCommission' },
  forSomeoneElseCount: { $sum: { $cond: ['$forSomeoneElse', 1, 0] } },
};

// VTpass service types stored in the Transaction collection
const VTPASS_TYPES = new Set(['airtime', 'data', 'tv', 'electricity', 'education', 'other']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDateRange(query) {
  const now  = new Date();
  const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to   = query.to   ? new Date(query.to)   : now;
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    const err = new Error('Invalid date format. Use ISO 8601 (e.g. 2026-05-01).');
    err.statusCode = 400;
    throw err;
  }
  return { from, to };
}

function _empty() {
  return {
    count: 0, totalUserPaid: 0, totalProviderCost: 0,
    totalOurMargin: 0, totalRecipientFee: 0, totalCommission: 0, forSomeoneElseCount: 0,
  };
}

// Add one row's numeric fields into an accumulator (safe to call with reduce)
function _add(acc, row) {
  acc.count               += row.count               || 0;
  acc.totalUserPaid       += row.totalUserPaid       || 0;
  acc.totalProviderCost   += row.totalProviderCost   || 0;
  acc.totalOurMargin      += row.totalOurMargin      || 0;
  acc.totalRecipientFee   += row.totalRecipientFee   || 0;
  acc.totalCommission     += row.totalCommission     || 0;
  acc.forSomeoneElseCount += row.forSomeoneElseCount || 0;
  return acc;
}

// Merge multiple aggregation result arrays into a Map keyed by _id, summing duplicates
function _mergeByKey(arrays) {
  const map = new Map();
  for (const arr of arrays) {
    for (const row of arr) {
      const k = String(row._id);
      if (!map.has(k)) map.set(k, _empty());
      _add(map.get(k), row);
    }
  }
  return map;
}

function _errResponse(res, err) {
  const s = err.statusCode || 500;
  return res.status(s).json({
    success: false,
    message: s === 400 ? err.message : 'Failed to load revenue data.',
  });
}

// ─── GET /api/admin/revenue/summary ──────────────────────────────────────────
// Overall KPIs for the date range, broken down by service and provider.
const getSummary = async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const df = { createdAt: { $gte: from, $lte: to } };

    const [txByType, betRows, examRows] = await Promise.all([
      Transaction.aggregate([
        { $match: { ...df, status: TX_SUCCESS } },
        { $group: { _id: '$type', ...ACCUM } },
      ]),
      BettingTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: 'betting', ...ACCUM } },
      ]),
      ExamPinTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: 'exam_pin', ...ACCUM } },
      ]),
    ]);

    // byService: one entry per transaction type
    const byService = {};
    for (const row of [...txByType, ...betRows, ...examRows]) {
      const { _id, ...nums } = row;
      byService[_id] = nums;
    }

    // Totals across all services
    const totals = Object.values(byService).reduce(_add, _empty());

    // Provider split: vtpass (Transaction) vs vtu-africa (Betting + ExamPin)
    const byProvider = { vtpass: _empty(), 'vtu-africa': _empty() };
    for (const row of txByType) {
      _add(VTPASS_TYPES.has(row._id) ? byProvider.vtpass : byProvider['vtu-africa'], row);
    }
    for (const row of [...betRows, ...examRows]) _add(byProvider['vtu-africa'], row);

    return res.json({ success: true, period: { from, to }, totals, byService, byProvider });
  } catch (err) {
    console.error('[revenueController] getSummary:', err.message);
    return _errResponse(res, err);
  }
};

// ─── GET /api/admin/revenue/daily ────────────────────────────────────────────
// Day-by-day revenue breakdown. Use ?from=&to= to limit range (default: current month).
const getDaily = async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const df     = { createdAt: { $gte: from, $lte: to } };
    const dayFmt = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };

    const [txRows, betRows, examRows] = await Promise.all([
      Transaction.aggregate([
        { $match: { ...df, status: TX_SUCCESS } },
        { $group: { _id: dayFmt, ...ACCUM } },
      ]),
      BettingTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: dayFmt, ...ACCUM } },
      ]),
      ExamPinTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: dayFmt, ...ACCUM } },
      ]),
    ]);

    const days = [..._mergeByKey([txRows, betRows, examRows]).entries()]
      .map(([date, nums]) => ({ date, ...nums }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return res.json({ success: true, period: { from, to }, days });
  } catch (err) {
    console.error('[revenueController] getDaily:', err.message);
    return _errResponse(res, err);
  }
};

// ─── GET /api/admin/revenue/monthly ──────────────────────────────────────────
// Month-by-month revenue. Default range: last 12 months.
const getMonthly = async (req, res) => {
  try {
    let { from, to } = parseDateRange(req.query);
    // Default to last 12 months when no from is specified
    if (!req.query.from) {
      from = new Date(to.getFullYear() - 1, to.getMonth(), 1);
    }

    const df       = { createdAt: { $gte: from, $lte: to } };
    const monthFmt = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };

    const [txRows, betRows, examRows] = await Promise.all([
      Transaction.aggregate([
        { $match: { ...df, status: TX_SUCCESS } },
        { $group: { _id: monthFmt, ...ACCUM } },
      ]),
      BettingTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: monthFmt, ...ACCUM } },
      ]),
      ExamPinTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: monthFmt, ...ACCUM } },
      ]),
    ]);

    const months = [..._mergeByKey([txRows, betRows, examRows]).entries()]
      .map(([month, nums]) => ({ month, ...nums }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return res.json({ success: true, period: { from, to }, months });
  } catch (err) {
    console.error('[revenueController] getMonthly:', err.message);
    return _errResponse(res, err);
  }
};

// ─── GET /api/admin/revenue/by-service ───────────────────────────────────────
// Revenue per service type, sorted by margin descending.
const getByService = async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const df = { createdAt: { $gte: from, $lte: to } };

    const [txRows, betRows, examRows] = await Promise.all([
      Transaction.aggregate([
        { $match: { ...df, status: TX_SUCCESS } },
        { $group: { _id: '$type', ...ACCUM } },
      ]),
      BettingTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: 'betting', ...ACCUM } },
      ]),
      ExamPinTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: 'exam_pin', ...ACCUM } },
      ]),
    ]);

    const services = [..._mergeByKey([txRows, betRows, examRows]).entries()]
      .map(([service, nums]) => ({ service, ...nums }))
      .sort((a, b) => b.totalOurMargin - a.totalOurMargin);

    return res.json({ success: true, period: { from, to }, services });
  } catch (err) {
    console.error('[revenueController] getByService:', err.message);
    return _errResponse(res, err);
  }
};

// ─── GET /api/admin/revenue/by-provider ──────────────────────────────────────
// Revenue split by provider (vtpass vs vtu-africa).
const getByProvider = async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const df = { createdAt: { $gte: from, $lte: to } };

    // Transaction.provider is set per record; Betting and ExamPin are always vtu-africa
    const [txRows, betRows, examRows] = await Promise.all([
      Transaction.aggregate([
        { $match: { ...df, status: TX_SUCCESS } },
        { $group: { _id: '$provider', ...ACCUM } },
      ]),
      BettingTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: 'vtu-africa', ...ACCUM } },
      ]),
      ExamPinTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: 'vtu-africa', ...ACCUM } },
      ]),
    ]);

    const providers = [..._mergeByKey([txRows, betRows, examRows]).entries()]
      .map(([provider, nums]) => ({
        provider: provider === 'null' ? 'unknown' : provider,
        ...nums,
      }))
      .sort((a, b) => b.totalOurMargin - a.totalOurMargin);

    return res.json({ success: true, period: { from, to }, providers });
  } catch (err) {
    console.error('[revenueController] getByProvider:', err.message);
    return _errResponse(res, err);
  }
};

// ─── GET /api/admin/revenue/top-users ────────────────────────────────────────
// Top users by revenue generated. ?limit=20 (max 100).
const getTopUsers = async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const df = { createdAt: { $gte: from, $lte: to } };

    const userAccum = {
      count:          { $sum: 1 },
      totalUserPaid:  { $sum: '$userPaid' },
      totalOurMargin: { $sum: '$ourMargin' },
    };

    const [txRows, betRows, examRows] = await Promise.all([
      Transaction.aggregate([
        { $match: { ...df, status: TX_SUCCESS } },
        { $group: { _id: '$userId', ...userAccum } },
      ]),
      BettingTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: '$userId', ...userAccum } },
      ]),
      ExamPinTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: '$userId', ...userAccum } },
      ]),
    ]);

    // Merge by userId
    const userMap = new Map();
    for (const row of [...txRows, ...betRows, ...examRows]) {
      const k = String(row._id);
      if (!userMap.has(k)) {
        userMap.set(k, { userId: row._id, count: 0, totalUserPaid: 0, totalOurMargin: 0 });
      }
      const u = userMap.get(k);
      u.count          += row.count          || 0;
      u.totalUserPaid  += row.totalUserPaid  || 0;
      u.totalOurMargin += row.totalOurMargin || 0;
    }

    const ranked = [...userMap.values()]
      .sort((a, b) => b.totalOurMargin - a.totalOurMargin)
      .slice(0, limit);

    // Hydrate with basic user details
    const userIds    = ranked.map(r => r.userId);
    const userDocs   = await User.find({ _id: { $in: userIds } })
      .select('firstName lastName email phoneNumber')
      .lean();
    const userLookup = new Map(userDocs.map(u => [String(u._id), u]));

    const result = ranked.map(r => ({
      ...r,
      user: userLookup.get(String(r.userId)) || null,
    }));

    return res.json({ success: true, period: { from, to }, limit, users: result });
  } catch (err) {
    console.error('[revenueController] getTopUsers:', err.message);
    return _errResponse(res, err);
  }
};

// ─── GET /api/admin/revenue/pay-for-others ───────────────────────────────────
// Summary of all forSomeoneElse=true transactions — recipient fee revenue.
const getPayForOthers = async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query);
    const df = { createdAt: { $gte: from, $lte: to }, forSomeoneElse: true };

    const [txRows, betRows, examRows] = await Promise.all([
      Transaction.aggregate([
        { $match: { ...df, status: TX_SUCCESS } },
        { $group: { _id: '$type', ...ACCUM } },
      ]),
      BettingTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: 'betting', ...ACCUM } },
      ]),
      ExamPinTransaction.aggregate([
        { $match: { ...df, status: VTU_SUCCESS } },
        { $group: { _id: 'exam_pin', ...ACCUM } },
      ]),
    ]);

    const byService = [..._mergeByKey([txRows, betRows, examRows]).entries()]
      .map(([service, nums]) => ({ service, ...nums }));
    const totals = byService.reduce(_add, _empty());

    return res.json({ success: true, period: { from, to }, totals, byService });
  } catch (err) {
    console.error('[revenueController] getPayForOthers:', err.message);
    return _errResponse(res, err);
  }
};

// ─── GET /api/admin/revenue/wallet-float ─────────────────────────────────────
// Total user wallet balances — the float PayFlex holds on users' behalf.
const getWalletFloat = async (req, res) => {
  try {
    const [result] = await User.aggregate([
      {
        $group: {
          _id:        null,
          totalFloat: { $sum: '$walletBalance' },
          userCount:  { $sum: 1 },
          maxBalance: { $max: '$walletBalance' },
          avgBalance: { $avg: '$walletBalance' },
          nonZeroCount: { $sum: { $cond: [{ $gt: ['$walletBalance', 0] }, 1, 0] } },
        },
      },
    ]);

    return res.json({
      success:      true,
      totalFloat:   result?.totalFloat   || 0,
      userCount:    result?.userCount    || 0,
      nonZeroCount: result?.nonZeroCount || 0,
      maxBalance:   result?.maxBalance   || 0,
      avgBalance:   Math.round((result?.avgBalance || 0) * 100) / 100,
    });
  } catch (err) {
    console.error('[revenueController] getWalletFloat:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load wallet float.' });
  }
};

module.exports = {
  getSummary,
  getDaily,
  getMonthly,
  getByService,
  getByProvider,
  getTopUsers,
  getPayForOthers,
  getWalletFloat,
};
