'use strict';

const Subscription = require('../models/Subscription');

// ─── GET /api/subscriptions/me ────────────────────────────────────────────────
// Returns the authenticated user's current subscription.
// Creates a free-plan record if none exists yet.
const getMySubscription = async (req, res) => {
  try {
    let sub = await Subscription.findOne({ userId: req.user.id }).lean();

    if (!sub) {
      sub = await Subscription.create({ userId: req.user.id, plan: 'free', status: 'active' });
      sub = sub.toObject();
    }

    return res.json({ success: true, subscription: sub });
  } catch (err) {
    console.error('[subscriptionController] getMySubscription:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load subscription.' });
  }
};

// ─── POST /api/subscriptions/upgrade ─────────────────────────────────────────
// Placeholder — paid plans not yet implemented.
const upgradeSubscription = (req, res) => {
  return res.status(501).json({
    success: false,
    message: 'Paid subscription plans are coming soon.',
  });
};

module.exports = { getMySubscription, upgradeSubscription };
