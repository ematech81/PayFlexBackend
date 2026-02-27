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
// BOOKING ROUTES
// ============================================

/**
 * Create new booking
 * @route POST /api/bookings
 * @access Private
 */
router.post('/', protect, createBooking);

/**
 * Get user's bookings (with pagination)
 * @route GET /api/bookings
 * @access Private
 * @query status - Filter by status (confirmed, cancelled, etc)
 * @query page - Page number (default: 1)
 * @query limit - Items per page (default: 20)
 */
router.get('/', protect, getUserBookings);

/**
 * Get single booking by ID
 * @route GET /api/bookings/:bookingId
 * @access Private
 */
router.get('/:bookingId', protect, getBooking);

/**
 * Get booking by reference
 * @route GET /api/bookings/reference/:reference
 * @access Private
 */
router.get('/reference/:reference', protect, getBookingByReference);

/**
 * Cancel booking
 * @route POST /api/bookings/:bookingId/cancel
 * @access Private
 */
router.post('/:bookingId/cancel', protect, cancelBooking);



// ============================================
// PASSENGER PROFILE ROUTES
// ============================================

/**
 * Get saved passenger profiles
 * @route GET /api/bookings/passengers/profiles
 * @access Private
 */
router.get('/passengers/profiles', protect, getPassengerProfiles);

/**
 * Search passenger by phone
 * @route GET /api/bookings/passengers/search/:phone
 * @access Private
 */
router.get('/passengers/search/:phone', protect, searchPassengerByPhone);






module.exports = router;