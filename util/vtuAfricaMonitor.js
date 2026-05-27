'use strict';

/**
 * VTU Africa Balance Monitor
 *
 * Runs on an hourly cron schedule. Fetches the VTU Africa account balance
 * and logs a warning or critical alert based on configured thresholds.
 *
 * Thresholds (override via env vars):
 *   VTUAFRICA_BALANCE_WARN_NGN     default: 20000  (₦20,000 — warn)
 *   VTUAFRICA_BALANCE_CRITICAL_NGN default:  5000  (₦5,000 — critical, consider disabling features)
 *
 * This module does NOT automatically disable features — it logs loudly so
 * ops can respond. If you want auto-disable, set FEATURE_EXAM_PINS_ENABLED=false
 * and FEATURE_BETTING_ENABLED=false in your environment and redeploy.
 */

const vtuAfricaService = require('../services/vtuAfricaService');

const WARN_THRESHOLD     = parseInt(process.env.VTUAFRICA_BALANCE_WARN_NGN     || '20000', 10);
const CRITICAL_THRESHOLD = parseInt(process.env.VTUAFRICA_BALANCE_CRITICAL_NGN ||  '5000', 10);

async function checkBalance() {
  try {
    const result = await vtuAfricaService.getBalance();

    if (!result.ok) {
      console.error('[vtuAfricaMonitor] Could not fetch balance:', result.description?.message || 'unknown error');
      return;
    }

    const balance = result.balance ?? 0;

    if (balance <= CRITICAL_THRESHOLD) {
      console.error(
        `[vtuAfricaMonitor] CRITICAL: VTU Africa balance is ₦${balance.toLocaleString()} ` +
        `(threshold: ₦${CRITICAL_THRESHOLD.toLocaleString()}). ` +
        `Services may fail. Consider disabling FEATURE_EXAM_PINS_ENABLED and FEATURE_BETTING_ENABLED.`
      );
    } else if (balance <= WARN_THRESHOLD) {
      console.warn(
        `[vtuAfricaMonitor] WARNING: VTU Africa balance is ₦${balance.toLocaleString()} ` +
        `(threshold: ₦${WARN_THRESHOLD.toLocaleString()}). Top up soon.`
      );
    } else {
      console.log(`[vtuAfricaMonitor] Balance OK: ₦${balance.toLocaleString()}`);
    }
  } catch (err) {
    console.error('[vtuAfricaMonitor] Unexpected error during balance check:', err.message);
  }
}

module.exports = { checkBalance };
