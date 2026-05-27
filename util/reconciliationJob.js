'use strict';

/**
 * Reconciliation Job
 *
 * Runs on a 30-minute cron schedule (registered in server.js or a process manager).
 * Finds ExamPinTransaction and BettingTransaction records that are still "pending"
 * after 5 minutes, queries VTU Africa for their real status, and resolves them.
 *
 * Resolution rules:
 *   - Status "Completed" → mark success, update charge fields, save pins if present
 *   - Any other status   → mark failed, refund wallet
 *   - Still pending after 2 hours → log a critical ops alert
 *
 * Safe to run multiple times — idempotency is guaranteed by the status check:
 * only records with status === 'pending' are touched.
 */

const vtuAfricaService   = require('../services/vtuAfricaService');
const ExamPinTransaction = require('../models/ExamPinTransaction');
const BettingTransaction = require('../models/BettingTransaction');
const User               = require('../models/user');
const { refundWalletBalance } = require('./paymentHelper');

const PENDING_GRACE_MS   = 5  * 60 * 1000; // 5 min before we start querying
const STALE_ALERT_MS     = 2  * 60 * 60 * 1000; // 2 hr — ops alert threshold

// ─── Main export ──────────────────────────────────────────────────────────────
async function runReconciliation() {
  const now       = new Date();
  const graceAge  = new Date(now - PENDING_GRACE_MS);
  const staleAge  = new Date(now - STALE_ALERT_MS);

  console.log(`[reconciliation] Starting run at ${now.toISOString()}`);

  const [examTxs, bettingTxs] = await Promise.all([
    ExamPinTransaction.find({
      status:    'pending',
      createdAt: { $lte: graceAge },
    }),
    BettingTransaction.find({
      status:    'pending',
      createdAt: { $lte: graceAge },
    }),
  ]);

  console.log(`[reconciliation] Found ${examTxs.length} exam + ${bettingTxs.length} betting pending.`);

  for (const tx of examTxs) {
    await _resolveExam(tx, staleAge);
  }

  for (const tx of bettingTxs) {
    await _resolveBetting(tx, staleAge);
  }

  console.log('[reconciliation] Run complete.');
}

// ─── Exam PIN resolution ──────────────────────────────────────────────────────
async function _resolveExam(tx, staleAge) {
  const { ref } = tx;
  try {
    if (tx.createdAt <= staleAge) {
      console.error(`[reconciliation] ALERT: Exam PIN ref ${ref} has been pending for >2 hours — manual review required.`);
    }

    const result = await vtuAfricaService.queryTransaction({ ref });

    if (!result.ok) {
      console.warn(`[reconciliation] queryTransaction failed for exam ref ${ref}: ${result.description?.message}`);
      return;
    }

    const desc = result.description || {};

    if (desc.Status === 'Completed') {
      tx.status               = 'success';
      tx.vtuAfricaReferenceId = desc.ReferenceID || tx.vtuAfricaReferenceId;
      tx.amountCharged        = parseFloat(desc.Amount_Charged || 0) || tx.amountCharged;
      tx.vtuAfricaCommission  = result.commission || tx.vtuAfricaCommission;

      const pins = vtuAfricaService.parsePins(desc.pins || '');
      if (pins.length > 0) tx.pins = pins;

      await tx.save();
      console.log(`[reconciliation] Exam PIN ref ${ref} resolved → success. Pins: ${pins.length}`);
    } else {
      // Not completed — refund and mark failed
      tx.status       = 'failed';
      tx.errorMessage = desc.message || `Reconciliation: Status=${desc.Status}`;
      await tx.save();

      await _refundUser(tx.userId, tx.totalCharged, ref, 'exam');
    }
  } catch (err) {
    console.error(`[reconciliation] Error resolving exam ref ${ref}:`, err.message);
  }
}

// ─── Betting resolution ───────────────────────────────────────────────────────
async function _resolveBetting(tx, staleAge) {
  const { ref } = tx;
  try {
    if (tx.createdAt <= staleAge) {
      console.error(`[reconciliation] ALERT: Betting ref ${ref} has been pending for >2 hours — manual review required.`);
    }

    const result = await vtuAfricaService.queryTransaction({ ref });

    if (!result.ok) {
      console.warn(`[reconciliation] queryTransaction failed for betting ref ${ref}: ${result.description?.message}`);
      return;
    }

    const desc = result.description || {};

    if (desc.Status === 'Completed') {
      tx.status               = 'success';
      tx.vtuAfricaReferenceId = desc.ReferenceID || tx.vtuAfricaReferenceId;
      tx.amountCharged        = parseFloat(desc.Amount_Charged || 0) || tx.amountCharged;
      tx.vtuAfricaCharge      = parseFloat(desc.Charge         || 0) || tx.vtuAfricaCharge;
      tx.vtuAfricaCommission  = result.commission || tx.vtuAfricaCommission;

      await tx.save();
      console.log(`[reconciliation] Betting ref ${ref} resolved → success.`);
    } else {
      tx.status       = 'failed';
      tx.errorMessage = desc.message || `Reconciliation: Status=${desc.Status}`;
      await tx.save();

      await _refundUser(tx.userId, tx.requestAmount, ref, 'betting');
    }
  } catch (err) {
    console.error(`[reconciliation] Error resolving betting ref ${ref}:`, err.message);
  }
}

// ─── Wallet refund helper ─────────────────────────────────────────────────────
async function _refundUser(userId, amount, ref, type) {
  try {
    const user = await User.findById(userId).select('+walletBalance');
    if (!user) {
      console.error(`[reconciliation] CRITICAL: Cannot refund — user ${userId} not found for ${type} ref ${ref}`);
      return;
    }
    await refundWalletBalance(user, amount);
    console.log(`[reconciliation] Refunded ₦${amount} to user ${userId} for failed ${type} ref ${ref}.`);
  } catch (err) {
    console.error(`[reconciliation] CRITICAL: Refund failed for ${type} ref ${ref} user ${userId}:`, err.message);
  }
}

module.exports = { runReconciliation };
