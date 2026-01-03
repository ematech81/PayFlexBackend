// controllers/referralController.js
const User = require('../models/user');
const Transaction = require('../models/transaction');
const crypto = require('crypto');

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Generate unique referral code
 */
const generateReferralCode = (firstName, lastName) => {
  // Create code from firstName + random string
  const namePrefix = firstName.substring(0, 4).toUpperCase();
  const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${namePrefix}${randomSuffix}`;
};

/**
 * Calculate referral reward
 */
const calculateReferralReward = (referralLevel) => {
  // Tier-based rewards
  const rewardTiers = {
    1: 500,    // First 10 referrals: ₦500 each
    2: 750,    // Next 20 referrals: ₦750 each
    3: 1000,   // 30+ referrals: ₦1000 each
  };

  if (referralLevel <= 10) return rewardTiers[1];
  if (referralLevel <= 30) return rewardTiers[2];
  return rewardTiers[3];
};

// ============================================
// GET USER REFERRAL INFO
// ============================================

exports.getReferralInfo = async (req, res) => {
  try {
    const userId = req.user._id;

    console.log('📊 Getting referral info for user:', userId);

    const user = await User.findById(userId).select(
      'referralCode referralLink totalReferrals referralEarnings referredBy'
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Generate referral code if not exists
    if (!user.referralCode) {
      user.referralCode = generateReferralCode(req.user.firstName, req.user.lastName);
      user.referralLink = `https://payflex.app/ref/${user.referralCode}`;
      await user.save();
    }

    // Get list of referred users
    const referredUsers = await User.find({ referredBy: userId })
      .select('firstName lastName email createdAt')
      .sort({ createdAt: -1 })
      .limit(50);

    // Get referral transactions
    const referralTransactions = await Transaction.find({
      userId: userId,
      type: 'referral_bonus',
    })
      .select('amount createdAt description')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({
      success: true,
      data: {
        referralCode: user.referralCode,
        referralLink: user.referralLink,
        totalReferrals: user.totalReferrals || 0,
        totalEarnings: user.referralEarnings || 0,
        referredUsers,
        recentTransactions: referralTransactions,
        currentTier: user.totalReferrals <= 10 ? 1 : user.totalReferrals <= 30 ? 2 : 3,
        nextTierReferrals: user.totalReferrals <= 10 ? 10 - user.totalReferrals : user.totalReferrals <= 30 ? 30 - user.totalReferrals : 0,
      },
    });
  } catch (error) {
    console.error('❌ Get Referral Info Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get referral information',
    });
  }
};

// ============================================
// VALIDATE REFERRAL CODE
// ============================================

exports.validateReferralCode = async (req, res) => {
  try {
    const { referralCode } = req.body;

    if (!referralCode) {
      return res.status(400).json({
        success: false,
        message: 'Referral code is required',
      });
    }

    const referrer = await User.findOne({ referralCode }).select('firstName lastName email');

    if (!referrer) {
      return res.status(404).json({
        success: false,
        message: 'Invalid referral code',
      });
    }

    // Cannot refer yourself
    if (referrer._id.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'You cannot use your own referral code',
      });
    }

    res.json({
      success: true,
      message: 'Valid referral code',
      data: {
        referrerName: `${referrer.firstName} ${referrer.lastName}`,
        referrerEmail: referrer.email,
      },
    });
  } catch (error) {
    console.error('❌ Validate Referral Code Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to validate referral code',
    });
  }
};

// ============================================
// APPLY REFERRAL CODE (During signup)
// ============================================

exports.applyReferralCode = async (req, res) => {
  try {
    const { referralCode } = req.body;
    const newUserId = req.user._id;

    console.log('🎁 Applying referral code:', referralCode, 'for user:', newUserId);

    // Check if user already used a referral
    const newUser = await User.findById(newUserId);
    
    if (newUser.referredBy) {
      return res.status(400).json({
        success: false,
        message: 'You have already used a referral code',
      });
    }

    // Find referrer
    const referrer = await User.findOne({ referralCode });

    if (!referrer) {
      return res.status(404).json({
        success: false,
        message: 'Invalid referral code',
      });
    }

    // Cannot refer yourself
    if (referrer._id.toString() === newUserId.toString()) {
      return res.status(400).json({
        success: false,
        message: 'You cannot use your own referral code',
      });
    }

    // Calculate reward
    const rewardAmount = calculateReferralReward(referrer.totalReferrals + 1);

    // Update referrer
    referrer.totalReferrals = (referrer.totalReferrals || 0) + 1;
    referrer.referralEarnings = (referrer.referralEarnings || 0) + rewardAmount;
    referrer.walletBalance = (referrer.walletBalance || 0) + rewardAmount;
    await referrer.save();

    // Update new user
    newUser.referredBy = referrer._id;
    await newUser.save();

    // Create transaction record for referrer
    await Transaction.create({
      userId: referrer._id,
      type: 'referral_bonus',
      amount: rewardAmount,
      status: 'successful',
      description: `Referral bonus from ${newUser.firstName} ${newUser.lastName}`,
      reference: `REF_${Date.now()}_${referrer._id}`,
    });

    // Send notification to referrer (implement later)
    // await sendReferralNotification(referrer, newUser, rewardAmount);

    res.json({
      success: true,
      message: 'Referral code applied successfully',
      data: {
        referrerName: `${referrer.firstName} ${referrer.lastName}`,
        rewardAmount,
      },
    });
  } catch (error) {
    console.error('❌ Apply Referral Code Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to apply referral code',
    });
  }
};

// ============================================
// GET REFERRAL LEADERBOARD
// ============================================

exports.getLeaderboard = async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    console.log('🏆 Getting referral leaderboard');

    const topReferrers = await User.find({ totalReferrals: { $gt: 0 } })
      .select('firstName lastName email totalReferrals referralEarnings')
      .sort({ totalReferrals: -1 })
      .limit(parseInt(limit));

    // Find current user's rank
    const currentUserReferrals = req.user.totalReferrals || 0;
    const usersAbove = await User.countDocuments({
      totalReferrals: { $gt: currentUserReferrals },
    });
    const currentUserRank = usersAbove + 1;

    res.json({
      success: true,
      data: {
        leaderboard: topReferrers.map((user, index) => ({
          rank: index + 1,
          name: `${user.firstName} ${user.lastName}`,
          email: user.email.substring(0, 3) + '***', // Privacy
          totalReferrals: user.totalReferrals,
          totalEarnings: user.referralEarnings,
        })),
        currentUserRank,
        currentUserReferrals,
      },
    });
  } catch (error) {
    console.error('❌ Get Leaderboard Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get leaderboard',
    });
  }
};

// ============================================
// CLAIM REFERRAL MILESTONE REWARD
// ============================================

exports.claimMilestoneReward = async (req, res) => {
  try {
    const userId = req.user._id;
    const { milestone } = req.body; // 10, 25, 50, 100

    console.log('🎉 Claiming milestone reward:', milestone, 'for user:', userId);

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Check if eligible
    if (user.totalReferrals < milestone) {
      return res.status(400).json({
        success: false,
        message: `You need ${milestone - user.totalReferrals} more referrals to claim this reward`,
      });
    }

    // Check if already claimed
    const claimedMilestones = user.claimedMilestones || [];
    if (claimedMilestones.includes(milestone)) {
      return res.status(400).json({
        success: false,
        message: 'You have already claimed this milestone reward',
      });
    }

    // Milestone rewards
    const milestoneRewards = {
      10: 2000,
      25: 5000,
      50: 15000,
      100: 50000,
    };

    const rewardAmount = milestoneRewards[milestone];

    if (!rewardAmount) {
      return res.status(400).json({
        success: false,
        message: 'Invalid milestone',
      });
    }

    // Credit reward
    user.walletBalance = (user.walletBalance || 0) + rewardAmount;
    user.referralEarnings = (user.referralEarnings || 0) + rewardAmount;
    user.claimedMilestones = [...claimedMilestones, milestone];
    await user.save();

    // Create transaction
    await Transaction.create({
      userId: user._id,
      type: 'referral_bonus',
      amount: rewardAmount,
      status: 'successful',
      description: `Milestone reward: ${milestone} referrals`,
      reference: `MILESTONE_${milestone}_${Date.now()}`,
    });

    res.json({
      success: true,
      message: `Congratulations! ₦${rewardAmount.toLocaleString()} credited to your wallet`,
      data: {
        milestone,
        rewardAmount,
        newBalance: user.walletBalance,
      },
    });
  } catch (error) {
    console.error('❌ Claim Milestone Reward Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to claim milestone reward',
    });
  }
};