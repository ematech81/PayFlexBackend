'use strict';

/**
 * Daily Margin Sanity Check
 *
 * Runs once per day (registered in server.js via setInterval).
 * Queries yesterday's successful transactions across all three collections and
 * verifies that stored ourMargin ≈ userPaid - providerCost for the day's aggregate.
 *
 * A discrepancy larger than TOLERANCE_NGN indicates a pricing bug or data
 * corruption — both warrant an immediate ops alert.
 *
 * Safe to run multiple times — purely read-only queries, no writes.
 */

const Transaction        = require('../models/transaction');
const BettingTransaction = require('../models/BettingTransaction');
const ExamPinTransaction = require('../models/ExamPinTransaction');

const TOLERANCE_NGN = parseFloat(process.env.MARGIN_SANITY_TOLERANCE_NGN) || 1.0; // rounding slack

function _yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return {
    from: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0),
    to:   new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999),
  };
}

// Aggregate: sum stored ourMargin and compute expected margin (userPaid - providerCost)
const MARGIN_PIPELINE = (from, to, successStatuses) => [
  { $match: { createdAt: { $gte: from, $lte: to }, status: { $in: successStatuses } } },
  {
    $group: {
      _id:                  null,
      storedMargin:         { $sum: '$ourMargin' },
      computedMargin:       { $sum: { $subtract: ['$userPaid', '$providerCost'] } },
      totalUserPaid:        { $sum: '$userPaid' },
      totalProviderCost:    { $sum: '$providerCost' },
      totalCommission:      { $sum: '$vtuAfricaCommission' },
      count:                { $sum: 1 },
    },
  },
];

async function runMarginSanityCheck() {
  const { from, to } = _yesterday();
  const dateLabel    = from.toISOString().slice(0, 10);

  console.log(`[marginSanity] Running check for ${dateLabel}…`);

  const [txResult, betResult, examResult] = await Promise.all([
    Transaction.aggregate(MARGIN_PIPELINE(from, to, ['success', 'completed'])),
    BettingTransaction.aggregate(MARGIN_PIPELINE(from, to, ['success'])),
    ExamPinTransaction.aggregate(MARGIN_PIPELINE(from, to, ['success'])),
  ]);

  // Each aggregate returns at most one row (grouped by null)
  const collections = [
    { name: 'Transaction',        row: txResult[0] },
    { name: 'BettingTransaction', row: betResult[0] },
    { name: 'ExamPinTransaction', row: examResult[0] },
  ];

  let anyFailed = false;

  for (const { name, row } of collections) {
    if (!row || row.count === 0) {
      console.log(`[marginSanity] ${name}: no transactions yesterday — skipping.`);
      continue;
    }

    const diff = Math.abs(row.storedMargin - row.computedMargin);

    if (diff > TOLERANCE_NGN) {
      anyFailed = true;
      console.error(
        `[marginSanity] CRITICAL — ${name} margin mismatch on ${dateLabel}!\n` +
        `  Transactions : ${row.count}\n` +
        `  storedMargin : ₦${row.storedMargin.toFixed(2)}\n` +
        `  computedMargin (userPaid - providerCost): ₦${row.computedMargin.toFixed(2)}\n` +
        `  Difference   : ₦${diff.toFixed(2)} (tolerance: ₦${TOLERANCE_NGN})\n` +
        `  totalUserPaid: ₦${row.totalUserPaid.toFixed(2)}\n` +
        `  totalProviderCost: ₦${row.totalProviderCost.toFixed(2)}\n` +
        `  totalCommission: ₦${row.totalCommission.toFixed(2)}`
      );
    } else {
      console.log(
        `[marginSanity] ${name} OK — ${row.count} txns, ` +
        `margin ₦${row.storedMargin.toFixed(2)}, diff ₦${diff.toFixed(4)}`
      );
    }
  }

  if (!anyFailed) {
    console.log(`[marginSanity] All collections passed for ${dateLabel}.`);
  }
}

module.exports = { runMarginSanityCheck };
