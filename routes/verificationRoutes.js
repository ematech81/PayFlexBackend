// routes/verificationRoutes.js
const express = require('express');
const { body, validationResult } = require('express-validator'); // ✅ Added validationResult import
const router = express.Router();
const { protect, adminOnly } = require('../middleware/auth');
const {
  verifyNIN,
  searchNINByPhone,
  searchNINByTracking,
  verifyBVN,
  searchBVNByPhone,
  checkBalance,
} = require('../controllers/verificationController');

// ============================================
// VALIDATION MIDDLEWARE
// ============================================

/**
 * Validation middleware to handle express-validator errors
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg,
      errors: errors.array(),
    });
  }
  
  next();
};

// ============================================
// NIN VERIFICATION ROUTES
// ============================================

/**
 * Verify NIN by Number (₦150)
 * @route POST /api/verification/verify-nin
 * @access Private
 */
router.post(
  '/verify-nin',
  protect,
  [
    body('nin')
      .isLength({ min: 11, max: 11 })
      .matches(/^\d{11}$/)
      .withMessage('NIN must be exactly 11 digits'),
    body('pin')
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage('PIN must be exactly 4 digits'),
  ],
  validate,
  verifyNIN
);

/**
 * Search NIN by Phone Number (₦200)
 * @route POST /api/verification/nin-by-phone
 * @access Private
 */
router.post(
  '/nin-by-phone',
  protect,
  [
    body('phone')
      .matches(/^0\d{10}$/)
      .withMessage('Invalid phone number format'),
    body('pin')
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage('PIN must be exactly 4 digits'),
  ],
  validate,
  searchNINByPhone
);

/**
 * Search NIN by Tracking ID (₦200)
 * @route POST /api/verification/nin-by-tracking
 * @access Private
 */
router.post(
  '/nin-by-tracking',
  protect,
  [
    body('trackingId')
      .notEmpty()
      .withMessage('Tracking ID is required'),
    body('pin')
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage('PIN must be exactly 4 digits'),
  ],
  validate,
  searchNINByTracking
);

// ============================================
// BVN VERIFICATION ROUTES
// ============================================

/**
 * Verify BVN by Number (₦100)
 * @route POST /api/verification/verify-bvn
 * @access Private
 */
router.post(
  '/verify-bvn',
  protect,
  [
    body('bvn')
      .isLength({ min: 11, max: 11 })
      .matches(/^\d{11}$/)
      .withMessage('BVN must be exactly 11 digits'),
    body('pin')
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage('PIN must be exactly 4 digits'),
  ],
  validate,
  verifyBVN
);

/**
 * Search BVN by Phone Number (₦150)
 * @route POST /api/verification/bvn-by-phone
 * @access Private
 */
router.post(
  '/bvn-by-phone',
  protect,
  [
    body('phone')
      .matches(/^0\d{10}$/)
      .withMessage('Invalid phone number format'),
    body('pin')
      .isLength({ min: 4, max: 4 })
      .matches(/^\d{4}$/)
      .withMessage('PIN must be exactly 4 digits'),
  ],
  validate,
  searchBVNByPhone
);

// ============================================
// ADMIN ROUTES
// ============================================

/**
 * Check API Balance
 * @route GET /api/verification/balance
 * @access Private (Admin only)
 */
router.get('/balance', protect, adminOnly, checkBalance);

module.exports = router;