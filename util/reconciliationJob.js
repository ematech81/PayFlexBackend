'use strict';

/**
 * Reconciliation Job
 *
 * Runs on a 30-minute cron schedule (registered in server.js or a process manager).
 * Finds ExamPinTransaction and BettingTransaction records that are still "pending"
 * after 5 minutes, queries VTU Africa for their real status, and resolves them.
 *
 * Also queries stuck bank_transfer transactions in 'processing' status after 10
 * minutes via KoraPay payout status endpoint, and refunds on confirmed failure.
 *
 * Resolution rules:
 *   - Status "Completed" → mark success, update charge fields, save pins if present
 *   - Any other status   → mark failed, refund wallet
 *   - Still pending after 2 hours → log a critical ops alert
 *
 * Safe to run multiple times — idempotency is guaranteed by the status check:
 * only records with status === 'pending' are touched.
 */

const mongoose           = require('mongoose');
const vtuAfricaService   = require('../services/vtuAfricaService');
const koraTransfer       = require('../services/koraTransferService');
const vtuTransferService = require('../services/vtuAfricaTransferService');
const ExamPinTransaction = require('../models/ExamPinTransaction');
const BettingTransaction = require('../models/BettingTransaction');
const Transaction        = require('../models/transaction');
const User               = require('../models/user');
const { refundWalletBalance } = require('./paymentHelper');

const PENDING_GRACE_MS   = 5  * 60 * 1000; // 5 min before we start querying
const TRANSFER_GRACE_MS  = 10 * 60 * 1000; // 10 min for KoraPay payouts
const STALE_ALERT_MS     = 2  * 60 * 60 * 1000; // 2 hr — ops alert threshold

// ─── Main export ──────────────────────────────────────────────────────────────
async function runReconciliation() {
  const now       = new Date();
  const graceAge  = new Date(now - PENDING_GRACE_MS);
  const staleAge  = new Date(now - STALE_ALERT_MS);

  console.log(`[reconciliation] Starting run at ${now.toISOString()}`);

  const transferGraceAge = new Date(now - TRANSFER_GRACE_MS);

  const [examTxs, bettingTxs, a2cTxs, transferTxs, vtuTransferTxs] = await Promise.all([
    ExamPinTransaction.find({
      status:    'pending',
      createdAt: { $lte: graceAge },
    }),
    BettingTransaction.find({
      status:    'pending',
      createdAt: { $lte: graceAge },
    }),
    Transaction.find({
      type:      'airtime_conversion',
      status:    'pending',
      createdAt: { $lte: graceAge },
    }),
    Transaction.find({
      type:      'bank_transfer',
      provider:  'kora-pay',
      status:    'processing',
      createdAt: { $lte: transferGraceAge },
    }),
    Transaction.find({
      type:      'bank_transfer',
      provider:  'vtu-africa',
      status:    'processing',
      createdAt: { $lte: transferGraceAge },
    }),
  ]);

  console.log(`[reconciliation] Found ${examTxs.length} exam + ${bettingTxs.length} betting + ${a2cTxs.length} A2C + ${transferTxs.length} KoraPay transfer + ${vtuTransferTxs.length} VTU transfer pending.`);

  for (const tx of examTxs)        { await _resolveExam(tx, staleAge);        }
  for (const tx of bettingTxs)     { await _resolveBetting(tx, staleAge);     }
  for (const tx of a2cTxs)         { await _resolveA2C(tx, staleAge);         }
  for (const tx of transferTxs)    { await _resolveTransfer(tx, staleAge);    }
  for (const tx of vtuTransferTxs) { await _resolveVtuTransfer(tx, staleAge); }

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

// ─── A2C resolution ───────────────────────────────────────────────────────────
async function _resolveA2C(tx, staleAge) {
  const ref = tx.reference;
  const session = await mongoose.startSession();
  try {
    if (tx.createdAt <= staleAge) {
      console.error(`[reconciliation] ALERT: A2C ref ${ref} has been pending for >2 hours — manual review required.`);
    }

    const result = await vtuAfricaService.queryTransaction({ ref });

    if (!result.ok) {
      console.warn(`[reconciliation] queryTransaction failed for A2C ref ${ref}: ${result.description?.message}`);
      return;
    }

    const desc = result.description || {};

    if (desc.Status === 'Completed') {
      session.startTransaction();
      const user = await User.findById(tx.userId).select('+walletBalance').session(session);
      if (!user) {
        await session.abortTransaction();
        console.error(`[reconciliation] CRITICAL: A2C ref ${ref} — user ${tx.userId} not found.`);
        return;
      }
      user.walletBalance = (user.walletBalance || 0) + tx.amount;
      await user.save({ session });
      tx.status = 'success';
      tx.metadata = { ...tx.metadata, vtuReferenceId: desc.ReferenceID };
      await tx.save({ session });
      await session.commitTransaction();
      console.log(`[reconciliation] A2C ref ${ref} resolved → success. ₦${tx.amount} credited to user ${tx.userId}.`);
    } else {
      tx.status = 'failed';
      tx.metadata = { ...tx.metadata, failureReason: desc.message || `Reconciliation: Status=${desc.Status}` };
      await tx.save();
      console.warn(`[reconciliation] A2C ref ${ref} resolved → failed (${desc.Status}). User already sent airtime — flag for ops review.`);
    }
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    console.error(`[reconciliation] Error resolving A2C ref ${ref}:`, err.message);
  } finally {
    session.endSession();
  }
}

// ─── VTU Africa bank transfer resolution ─────────────────────────────────────
async function _resolveVtuTransfer(tx, staleAge) {
  const ref = tx.reference;
  try {
    if (tx.createdAt <= staleAge) {
      console.error(`[reconciliation] ALERT: VTU transfer ref ${ref} has been processing for >2 hours — manual review required.`);
    }
    const result = await vtuTransferService.queryTransfer({ ref });
    const desc   = result?.description || {};

    if (desc.Status === 'Completed') {
      await Transaction.findByIdAndUpdate(tx._id, { status: 'success', response: desc });
      console.log(`[reconciliation] VTU transfer ref ${ref} resolved → success.`);
    } else if (result?.ok === false) {
      const user = await User.findById(tx.userId).select('+walletBalance');
      if (user) await refundWalletBalance(user, tx.amount);
      await Transaction.findByIdAndUpdate(tx._id, { status: 'failed', failureReason: desc.message || 'Failed per reconciliation', response: desc });
      console.log(`[reconciliation] VTU transfer ref ${ref} resolved → failed. ₦${tx.amount} refunded.`);
    } else {
      console.log(`[reconciliation] VTU transfer ref ${ref} still pending — will retry next run.`);
    }
  } catch (err) {
    console.error(`[reconciliation] Error resolving VTU transfer ref ${ref}:`, err.message);
  }
}

// ─── Bank transfer (KoraPay payout) resolution ───────────────────────────────
async function _resolveTransfer(tx, staleAge) {
  const ref = tx.reference;
  try {
    if (tx.createdAt <= staleAge) {
      console.error(`[reconciliation] ALERT: Bank transfer ref ${ref} has been processing for >2 hours — manual review required.`);
    }

    const koraData = await koraTransfer.getTransferStatus(ref);
    const status   = koraData?.status;

    if (status === 'success') {
      await Transaction.findByIdAndUpdate(tx._id, { status: 'success', response: koraData });
      console.log(`[reconciliation] Transfer ref ${ref} resolved → success.`);
    } else if (status === 'failed') {
      const user = await User.findById(tx.userId).select('+walletBalance');
      if (user) await refundWalletBalance(user, tx.amount);
      await Transaction.findByIdAndUpdate(tx._id, {
        status:        'failed',
        failureReason: koraData?.narration || 'Transfer failed per KoraPay reconciliation',
        response:      koraData,
      });
      console.log(`[reconciliation] Transfer ref ${ref} resolved → failed. ₦${tx.amount} refunded to user ${tx.userId}.`);
    } else {
      console.log(`[reconciliation] Transfer ref ${ref} still ${status || 'unknown'} — will retry next run.`);
    }
  } catch (err) {
    console.error(`[reconciliation] Error resolving transfer ref ${ref}:`, err.message);
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
