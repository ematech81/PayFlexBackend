// routes/bookingRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  createBooking,
  getUserBookings,
  getBooking,
  getBookingByReference,
  cancelBooking,
  getPassengerProfiles,
  searchPassengerByPhone,
} = require('../controllers/BookingController');

// ============================================
// SPECIFIC ROUTES FIRST (must precede /:bookingId)
// ============================================

router.get('/passengers/profiles', protect, getPassengerProfiles);
router.get('/passengers/search/:phone', protect, searchPassengerByPhone);
router.get('/reference/:reference', protect, getBookingByReference);

// ============================================
// COLLECTION ROUTES
// ============================================

router.post('/', protect, createBooking);
router.get('/', protect, getUserBookings);

// ============================================
// WILDCARD PARAM ROUTES LAST
// ============================================

router.get('/:bookingId', protect, getBooking);
router.post('/:bookingId/cancel', protect, cancelBooking);

module.exports = router;
