'use strict';

/**
 * VTU Africa Webhook Controller
 *
 * Receives asynchronous status updates and JAMB PIN delivery.
 *
 * Security (defense-in-depth — both layers must pass before any action is taken):
 *   Layer 1: Verify payload.apikey === MD5(our_api_key)
 *   Layer 2: Independently query VTU Africa's transaction-verify endpoint
 *            and confirm Status === "Completed" before crediting anything.
 *
 * Idempotency: a ref that is already "success" is silently accepted (200)
 * without re-processing. Replayed webhooks cannot double-credit.
 *
 * The handler always returns 200 to VTU Africa — even on rejection — to
 * prevent their retry queue from flooding us with the same payload.
 */

const mongoose              = require('mongoose');
const vtuAfricaService      = require('../services/vtuAfricaService');
const pushService           = require('../services/pushNotificationService');
const ExamPinTransaction    = require('../models/ExamPinTransaction');
const BettingTransaction    = require('../models/BettingTransaction');
const Transaction           = require('../models/transaction');
const User                  = require('../models/user');

// ─── Main handler ─────────────────────────────────────────────────────────────
const handleWebhook = async (req, res) => {
  // Always acknowledge immediately — processing happens below
  // VTU Africa re-queues if they don't get a 2xx promptly
  res.status(200).json({ received: true });

  // ── Parse raw body ─────────────────────────────────────────────────────────
  // express.raw() is mounted on this path in server.js, so req.body is a Buffer
  let payload;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    payload   = JSON.parse(raw);
  } catch {
    console.warn('[vtuAfricaWebhook] Could not parse body — ignoring.');
    return;
  }

  const ref = payload?.ref || payload?.Ref || payload?.reference;
  if (!ref) {
    console.warn('[vtuAfricaWebhook] Payload missing ref — ignoring:', JSON.stringify(payload));
    return;
  }

  console.log(`[vtuAfricaWebhook] Received for ref: ${ref}`);

  // ── Security: Layer 1 + Layer 2 ───────────────────────────────────────────
  const verification = await vtuAfricaService.verifyWebhook({ ...payload, ref });
  if (!verification.valid) {
    console.warn(`[vtuAfricaWebhook] Rejected (${verification.reason}) for ref: ${ref}`);
    return;
  }

  // queryResult is the authoritative source from VTU Africa's transaction-verify endpoint
  const { queryResult } = verification;

  // ── Idempotency: find the matching local transaction ───────────────────────
  const examTx    = await ExamPinTransaction.findOne({ ref });
  const bettingTx = examTx ? null : await BettingTransaction.findOne({ ref });

  // Bills transactions use ref prefixes: payflex-elec-, payflex-air-, payflex-data-, payflex-tv-
  const isElecRef = ref.startsWith('payflex-elec-');
  const elecTx    = (!examTx && !bettingTx && isElecRef)
                  ? await Transaction.findOne({ reference: ref, type: 'electricity' })
                  : null;
  const a2cTx     = (!examTx && !bettingTx && !elecTx)
                  ? await Transaction.findOne({ reference: ref, type: 'airtime_conversion' })
                  : null;

  const txDoc = examTx || bettingTx || elecTx || a2cTx;

  if (!txDoc) {
    console.warn(`[vtuAfricaWebhook] No local transaction found for ref: ${ref}`);
    return;
  }

  // Already fully resolved — do nothing (idempotency guard)
  if (txDoc.status === 'success' || txDoc.status === 'refunded') {
    console.log(`[vtuAfricaWebhook] Ref ${ref} already in status "${txDoc.status}" — skipping.`);
    return;
  }

  // ── Update exam pin transaction ────────────────────────────────────────────
  if (examTx) {
    await _processExamWebhook(examTx, queryResult, payload);
    return;
  }

  // ── Update betting transaction ─────────────────────────────────────────────
  if (bettingTx) {
    await _processBettingWebhook(bettingTx, queryResult, payload);
    return;
  }

  // ── Update electricity transaction + deliver token ────────────────────────
  if (elecTx) {
    await _processElectricityWebhook(elecTx, queryResult, payload);
    return;
  }

  // ── Update Airtime2Cash transaction + credit wallet ────────────────────────
  if (a2cTx) {
    await _processA2CWebhook(a2cTx, queryResult);
  }
};

// ─── Exam PIN webhook processing ──────────────────────────────────────────────
async function _processExamWebhook(txDoc, queryResult, payload) {
  const ref = txDoc.ref;

  try {
    const pinsString = queryResult.description?.pins || payload?.pins || '';
    const pins       = vtuAfricaService.parsePins(pinsString);

    if (queryResult.ok && queryResult.description?.Status === 'Completed') {
      txDoc.status              = 'success';
      txDoc.vtuAfricaReferenceId = queryResult.description?.ReferenceID || txDoc.vtuAfricaReferenceId;
      txDoc.amountCharged       = parseFloat(queryResult.description?.Amount_Charged || 0) || txDoc.amountCharged;
      txDoc.vtuAfricaCommission = queryResult.commission || txDoc.vtuAfricaCommission;

      if (pins.length > 0) txDoc.pins = pins;

      await txDoc.save();
      console.log(`[vtuAfricaWebhook] Exam PIN ref ${ref} marked success. Pins delivered: ${pins.length}`);

      // TODO: send push/in-app notification to user when notification system is ready
    } else {
      // Webhook arrived but transaction query says it is not completed — mark failed
      txDoc.status       = 'failed';
      txDoc.errorMessage = queryResult.description?.message || 'Transaction not confirmed by VTU Africa.';
      await txDoc.save();
      console.warn(`[vtuAfricaWebhook] Exam PIN ref ${ref} marked failed — query status: ${queryResult.description?.Status}`);

      // Wallet refund for exam pins on failure
      // Note: user document is not in scope here — refund is handled by the
      // reconciliation job which has access to the full user + wallet helpers.
      console.warn(`[vtuAfricaWebhook] Exam PIN ref ${ref} needs wallet refund — reconciliation job will process.`);
    }
  } catch (err) {
    console.error(`[vtuAfricaWebhook] Error processing exam PIN ref ${ref}:`, err.message);
  }
}

// ─── Betting webhook processing ───────────────────────────────────────────────
async function _processBettingWebhook(txDoc, queryResult, payload) {
  const ref = txDoc.ref;

  try {
    if (queryResult.ok && queryResult.description?.Status === 'Completed') {
      txDoc.status               = 'success';
      txDoc.vtuAfricaReferenceId = queryResult.description?.ReferenceID || txDoc.vtuAfricaReferenceId;
      txDoc.amountCharged        = parseFloat(queryResult.description?.Amount_Charged || 0) || txDoc.amountCharged;
      txDoc.vtuAfricaCharge      = parseFloat(queryResult.description?.Charge         || 0) || txDoc.vtuAfricaCharge;
      txDoc.vtuAfricaCommission  = queryResult.commission || txDoc.vtuAfricaCommission;
      await txDoc.save();
      console.log(`[vtuAfricaWebhook] Betting ref ${ref} marked success.`);
    } else {
      txDoc.status       = 'failed';
      txDoc.errorMessage = queryResult.description?.message || 'Transaction not confirmed by VTU Africa.';
      await txDoc.save();
      console.warn(`[vtuAfricaWebhook] Betting ref ${ref} marked failed — query status: ${queryResult.description?.Status}`);
      console.warn(`[vtuAfricaWebhook] Betting ref ${ref} needs wallet refund — reconciliation job will process.`);
    }
  } catch (err) {
    console.error(`[vtuAfricaWebhook] Error processing betting ref ${ref}:`, err.message);
  }
}

// ─── Airtime2Cash webhook processing ─────────────────────────────────────────
async function _processA2CWebhook(txDoc, queryResult) {
  const ref = txDoc.reference;
  const session = await mongoose.startSession();
  try {
    if (queryResult.ok && queryResult.description?.Status === 'Completed') {
      session.startTransaction();

      const user = await User.findById(txDoc.userId).select('+walletBalance').session(session);
      if (!user) {
        await session.abortTransaction();
        console.error(`[vtuAfricaWebhook] A2C ref ${ref}: user ${txDoc.userId} not found — aborting.`);
        return;
      }

      const creditAmount = txDoc.amount; // already set to userReceives at creation time
      user.walletBalance = (user.walletBalance || 0) + creditAmount;
      await user.save({ session });

      txDoc.status = 'success';
      txDoc.metadata = { ...txDoc.metadata, vtuReferenceId: queryResult.description?.ReferenceID };
      await txDoc.save({ session });

      await session.commitTransaction();
      console.log(`[vtuAfricaWebhook] A2C ref ${ref} success — ₦${creditAmount} credited to user ${txDoc.userId}.`);
    } else {
      txDoc.status = 'failed';
      txDoc.metadata = { ...txDoc.metadata, failureReason: queryResult.description?.message || 'Not confirmed by VTU Africa.' };
      await txDoc.save();
      console.warn(`[vtuAfricaWebhook] A2C ref ${ref} marked failed — query status: ${queryResult.description?.Status}`);
    }
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    console.error(`[vtuAfricaWebhook] Error processing A2C ref ${ref}:`, err.message);
  } finally {
    session.endSession();
  }
}

// ─── Electricity webhook processing ──────────────────────────────────────────
// Handles late token delivery for payflex-elec-* references.
// The token may have already arrived in the API response (purchasedCode set).
// If it arrives here via webhook, update the transaction and notify the user.
async function _processElectricityWebhook(txDoc, queryResult, payload) {
  const ref = txDoc.reference;
  try {
    const d = queryResult.description || payload?.description || {};

    if (queryResult.ok && (d.Status === 'Completed' || d.Status === 'completed')) {
      const token = d.Token || d.token || payload?.Token || null;
      const unit  = d.Unit  || d.unit  || payload?.Unit  || null;

      // Update transaction — token may be arriving for the first time via webhook
      txDoc.status = 'success';
      if (token) {
        txDoc.purchasedCode = token;
        if (unit) txDoc.tokenUnits = unit;
        console.log(`[vtuAfricaWebhook] Electricity token received via webhook for ref ${ref}: ${token}`);
      } else {
        console.warn(`[vtuAfricaWebhook] Electricity webhook for ref ${ref} — Status Completed but no token field`);
      }

      txDoc.transactionId = d.ReferenceID || txDoc.transactionId;
      await txDoc.save();

      // Fire push notification for electricity token
      await pushService.sendToUser(txDoc.userId, {
        title: 'Electricity Token Ready ⚡',
        body: token
          ? `Your token: ${token}`
          : 'Your electricity payment was successful.',
        data: { type: 'electricity_token', reference: ref, token: token || null },
      });

    } else {
      txDoc.status       = 'failed';
      txDoc.failureReason = d.message || 'Electricity payment not confirmed by VTU Africa.';
      await txDoc.save();
      console.warn(`[vtuAfricaWebhook] Electricity ref ${ref} marked failed — status: ${d.Status}`);
    }
  } catch (err) {
    console.error(`[vtuAfricaWebhook] Error processing electricity ref ${ref}:`, err.message);
  }
}

module.exports = { handleWebhook };
