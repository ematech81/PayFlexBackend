// routes/referralRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getReferralInfo,
  validateReferralCode,
  applyReferralCode,
  getLeaderboard,
  claimMilestoneReward,
} = require('../controllers/referralController');

// ============================================
// REFERRAL ROUTES
// ============================================

/**
 * Get user's referral information
 * @route GET /api/referral
 * @access Private
 */
router.get('/', protect, getReferralInfo);

/**
 * Validate referral code
 * @route POST /api/referral/validate
 * @access Private
 */
router.post('/validate', protect, validateReferralCode);

/**
 * Apply referral code
 * @route POST /api/referral/apply
 * @access Private
 */
router.post('/apply', protect, applyReferralCode);

/**
 * Get referral leaderboard
 * @route GET /api/referral/leaderboard
 * @access Private
 */
router.get('/leaderboard', protect, getLeaderboard);

/**
 * Claim milestone reward
 * @route POST /api/referral/claim-milestone
 * @access Private
 */
router.post('/claim-milestone', protect, claimMilestoneReward);

module.exports = router;