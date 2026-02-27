// routes/flightRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  searchAirports,
  getAirportById,
  searchFlights,
  getFlightInspiration,
  confirmFlightPrice,
  getFlightSeatmap,
  createFlightOrder,
  getFlightOrder,
  cancelFlightOrder,
  getCheckinLinks,
  getFlightStatus,
  getPassengerProfiles,
  searchPassengerByPhone,
} = require('../controllers/flightController');

// ============================================
// PUBLIC ROUTES (No Authentication Required)
// ============================================

/**
 * Search airports and cities
 * @route GET /api/flights/airports/search?keyword=london
 * @access Public
 * @query {
 *   keyword: string (required, min 2 chars),
 *   subType: 'AIRPORT' | 'CITY' | 'AIRPORT,CITY',
 *   countryCode: 'US' | 'NG' | etc,
 *   page[limit]: number (default 10),
 *   page[offset]: number (default 0),
 *   sort: 'analytics.travelers.score',
 *   view: 'FULL' | 'LIGHT'
 * }
 */
router.get('/airports/search', searchAirports);

/**
 * Get specific airport or city by location ID
 * @route GET /api/flights/airports/:locationId
 * @access Public
 * @param locationId - Location identifier (e.g., CMUC, AMUC)
 */
router.get('/airports/:locationId', getAirportById);

/**
 * Search for flight offers
 * @route POST /api/flights/search
 * @access Public
 * @body {
 *   originLocationCode: 'LOS',
 *   destinationLocationCode: 'LHR',
 *   departureDate: '2024-12-25',
 *   returnDate: '2025-01-05',
 *   adults: 1,
 *   children: 0,
 *   infants: 0,
 *   travelClass: 'ECONOMY',
 *   nonStop: false,
 *   currencyCode: 'NGN',
 *   maxResults: 50
 * }
 */
router.post('/search', searchFlights);

/**
 * Get flight inspiration / popular destinations
 * @route GET /api/flights/inspiration?origin=LOS
 * @access Public
 */
router.get('/inspiration', getFlightInspiration);

/**
 * Confirm flight price and availability
 * @route POST /api/flights/price-confirm
 * @access Public
 * @body {
 *   flightOffers: [flightOffer1, flightOffer2, ...]
 * }
 */
router.post('/price-confirm', confirmFlightPrice);

/**
 * Get seatmap for flight
 * @route POST /api/flights/seatmap
 * @access Public
 * @body {
 *   flightOffers: [flightOffer]
 * }
 */
router.post('/seatmap', getFlightSeatmap);

/**
 * Get check-in links for airline
 * @route GET /api/flights/checkin-links?airlineCode=BA
 * @access Public
 */
router.get('/checkin-links', getCheckinLinks);

/**
 * Get real-time flight status
 * @route GET /api/flights/status?flightNumber=BA123&flightDate=2024-12-25
 * @access Public
 */
router.get('/status', getFlightStatus);

// ============================================
// PROTECTED ROUTES (Authentication Required)
// ============================================

/**
 * Create flight booking order
 * @route POST /api/flights/book
 * @access Private
 * @body {
 *   flightOffers: [flightOffer],
 *   travelers: [traveler1, traveler2, ...],
 *   contacts: [contact],
 *   remarks: {...}
 * }
 */
router.post('/book', protect, createFlightOrder);

/**
 * Get flight order details
 * @route GET /api/flights/orders/:orderId
 * @access Private
 */
router.get('/orders/:orderId', protect, getFlightOrder);

/**
 * Cancel flight order
 * @route DELETE /api/flights/orders/:orderId
 * @access Private
 */
router.delete('/orders/:orderId', protect, cancelFlightOrder);

// ============================================
// PASSENGER PROFILE ROUTES (SHARED WITH TRANSPORT)
// ============================================

/**
 * Get saved passenger profiles
 * @route GET /api/flights/passengers/profiles
 * @access Private
 */
router.get('/passengers/profiles', protect, getPassengerProfiles);

/**
 * Search passenger by phone (for auto-fill)
 * @route GET /api/flights/passengers/search/:phone
 * @access Private
 */
router.get('/passengers/search/:phone', protect, searchPassengerByPhone);

module.exports = router;