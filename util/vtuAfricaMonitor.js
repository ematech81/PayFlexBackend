'use strict';

const vtuAfricaService = require('../services/vtuAfricaService');
const { sendEmail }    = require('./sendEmail');

const WARN_THRESHOLD     = parseInt(process.env.VTUAFRICA_BALANCE_WARN_NGN     || '20000', 10);
const CRITICAL_THRESHOLD = parseInt(process.env.VTUAFRICA_BALANCE_CRITICAL_NGN ||  '5000', 10);

const OPS_EMAIL = process.env.OPS_ALERT_EMAIL || process.env.SMTP_FROM || 'nwankwolivinus95@gmail.com';

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
        `(threshold: ₦${CRITICAL_THRESHOLD.toLocaleString()}). Services may fail.`
      );
      await sendEmail(
        OPS_EMAIL,
        '🚨 PayFlex CRITICAL: VTU Africa balance critically low',
        `Your VTU Africa merchant wallet balance is ₦${balance.toLocaleString()}.\n\n` +
        `This is below the critical threshold of ₦${CRITICAL_THRESHOLD.toLocaleString()}. ` +
        `Bank transfers and VAS services may start failing for your users.\n\n` +
        `Please top up your VTU Africa merchant wallet immediately via the VTU Africa dashboard.`
      ).catch(e => console.error('[vtuAfricaMonitor] Failed to send critical alert email:', e.message));
    } else if (balance <= WARN_THRESHOLD) {
      console.warn(
        `[vtuAfricaMonitor] WARNING: VTU Africa balance is ₦${balance.toLocaleString()} ` +
        `(threshold: ₦${WARN_THRESHOLD.toLocaleString()}). Top up soon.`
      );
      await sendEmail(
        OPS_EMAIL,
        '⚠️ PayFlex Warning: VTU Africa balance is low',
        `Your VTU Africa merchant wallet balance is ₦${balance.toLocaleString()}.\n\n` +
        `This is below the warning threshold of ₦${WARN_THRESHOLD.toLocaleString()}. ` +
        `Please top up your VTU Africa merchant wallet soon to avoid service disruptions.\n\n` +
        `Log in to the VTU Africa dashboard to fund your account.`
      ).catch(e => console.error('[vtuAfricaMonitor] Failed to send warning email:', e.message));
    } else {
      console.log(`[vtuAfricaMonitor] Balance OK: ₦${balance.toLocaleString()}`);
    }
  } catch (err) {
    console.error('[vtuAfricaMonitor] Unexpected error during balance check:', err.message);
  }
}

module.exports = { checkBalance };
