// controllers/flightController.js
const Amadeus = require('amadeus');
const FlightBooking = require('../models/FlightBooking');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { 
  savePassengerProfiles, 
  getUserProfiles, 
  searchPassengerByPhone: searchPassenger 
} = require('../util/passengerProfile');

// Initialize Amadeus client
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET,
  hostname: process.env.NODE_ENV === 'production' ? 'production' : 'test',
});

// ============================================
// AIRPORT & CITY SEARCH
// ============================================

/**
 * Search airports and cities
 * @route GET /api/flights/airports/search
 * @access Public
 * @query {
 *   keyword: 'MUC' (required, min 2 chars),
 *   subType: 'AIRPORT,CITY' (optional),
 *   countryCode: 'DE' (optional),
 *   page[limit]: 10 (optional),
 *   page[offset]: 0 (optional),
 *   sort: 'analytics.travelers.score' (optional),
 *   view: 'FULL' or 'LIGHT' (optional)
 * }
 */
exports.searchAirports = async (req, res) => {
  try {
    const { 
      keyword, 
      subType, 
      countryCode, 
      sort, 
      view 
    } = req.query;

    // Parse pagination
    const limit = parseInt(req.query['page[limit]']) || 10;
    const offset = parseInt(req.query['page[offset]']) || 0;

    if (!keyword || keyword.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Please provide at least 2 characters to search',
        errors: [{
          status: 400,
          code: 477,
          title: 'INVALID FORMAT',
          detail: 'keyword must be at least 2 characters',
          source: {
            parameter: 'keyword',
            example: 'MUC'
          }
        }]
      });
    }

    console.log('🔍 Searching airports for:', keyword);

    // Build search parameters
    const searchParams = {
      keyword: keyword.toUpperCase(),
      'page[limit]': limit,
      'page[offset]': offset,
    };

    // Add optional parameters
    if (subType) {
      searchParams.subType = subType; // AIRPORT, CITY, or AIRPORT,CITY
    } else {
      searchParams.subType = Amadeus.location.any; // Default to both
    }

    if (countryCode) {
      searchParams.countryCode = countryCode.toUpperCase();
    }

    if (sort) {
      searchParams.sort = sort;
    }

    if (view) {
      searchParams.view = view; // LIGHT or FULL
    }

    const response = await amadeus.referenceData.locations.get(searchParams);

    console.log(`✅ Found ${response.data.length} locations`);

    res.json({
      success: true,
      data: response.data,
      meta: response.result.meta,
    });

  } catch (error) {
    console.error('❌ Airport search error:', error);

    // Handle Amadeus-specific errors
    if (error.response) {
      const amadeusError = error.response.result?.errors?.[0];
      
      if (amadeusError) {
        return res.status(error.response.statusCode || 500).json({
          success: false,
          message: amadeusError.title || 'Search failed',
          errors: error.response.result.errors,
        });
      }
    }

    // Generic error
    res.status(500).json({
      success: false,
      message: 'Failed to search airports',
      errors: [{
        status: 500,
        code: 141,
        title: 'SYSTEM ERROR HAS OCCURRED',
        detail: error.message
      }]
    });
  }
};

/**
 * Get specific airport or city by location ID
 * @route GET /api/flights/airports/:locationId
 * @access Public
 */
exports.getAirportById = async (req, res) => {
  try {
    const { locationId } = req.params;

    if (!locationId) {
      return res.status(400).json({
        success: false,
        message: 'Location ID is required',
        errors: [{
          status: 400,
          code: 477,
          title: 'INVALID FORMAT',
          detail: 'locationId parameter is required',
          source: {
            parameter: 'locationId',
            example: 'CMUC'
          }
        }]
      });
    }

    console.log('📍 Getting airport by ID:', locationId);

    const response = await amadeus.referenceData.location(locationId).get();

    res.json({
      success: true,
      data: response.data,
      meta: response.result.meta,
    });

  } catch (error) {
    console.error('❌ Airport retrieval error:', error);

    // Handle 404 - Not Found
    if (error.response?.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: 'Location not found',
        errors: [{
          status: 404,
          code: 1797,
          title: 'NOT FOUND',
          detail: 'no response found for this location ID',
          source: {
            parameter: 'locationId',
            value: req.params.locationId
          }
        }]
      });
    }

    // Handle Amadeus-specific errors
    if (error.response) {
      const amadeusError = error.response.result?.errors?.[0];
      
      if (amadeusError) {
        return res.status(error.response.statusCode || 500).json({
          success: false,
          message: amadeusError.title || 'Request failed',
          errors: error.response.result.errors,
        });
      }
    }

    // Generic error
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve location',
      errors: [{
        status: 500,
        code: 141,
        title: 'SYSTEM ERROR HAS OCCURRED',
        detail: error.message
      }]
    });
  }
};

// ============================================
// FLIGHT OFFERS SEARCH
// ============================================

/**
 * Search for flight offers
 * @route POST /api/flights/search
 * @access Public
 * @body {
 *   originLocationCode: 'LOS',
 *   destinationLocationCode: 'LHR',
 *   departureDate: '2024-12-25',
 *   returnDate: '2025-01-05' (optional),
 *   adults: 1,
 *   children: 0 (optional),
 *   infants: 0 (optional),
 *   travelClass: 'ECONOMY' (optional),
 *   nonStop: false (optional),
 *   currencyCode: 'NGN' (optional),
 *   maxResults: 50 (optional)
 * }
 */
exports.searchFlights = async (req, res) => {
  try {
    const {
      originLocationCode,
      destinationLocationCode,
      departureDate,
      returnDate,
      adults,
      children,
      infants,
      travelClass,
      nonStop,
      currencyCode,
      maxResults,
    } = req.body;

    // Validate required fields
    if (!originLocationCode || !destinationLocationCode || !departureDate) {
      return res.status(400).json({
        success: false,
        message: 'Origin, destination and departure date are required',
        errors: [{
          status: 400,
          code: 477,
          title: 'INVALID FORMAT',
          detail: 'Missing required parameters: originLocationCode, destinationLocationCode, departureDate',
          source: {
            parameter: 'body',
            example: {
              originLocationCode: 'LOS',
              destinationLocationCode: 'LHR',
              departureDate: '2024-12-25',
              adults: 1
            }
          }
        }]
      });
    }

    if (!adults || adults < 1) {
      return res.status(400).json({
        success: false,
        message: 'At least 1 adult passenger is required',
        errors: [{
          status: 400,
          code: 477,
          title: 'INVALID FORMAT',
          detail: 'adults parameter must be at least 1',
        }]
      });
    }

    console.log('✈️ Searching flights:', {
      originLocationCode,
      destinationLocationCode,
      departureDate,
      adults: adults || 1,
    });

    // Build search parameters
    const searchParams = {
      originLocationCode,
      destinationLocationCode,
      departureDate,
      adults: (adults || 1).toString(),
      max: maxResults || 50,
    };

    // Add optional parameters
    if (returnDate) searchParams.returnDate = returnDate;
    if (children) searchParams.children = children.toString();
    if (infants) searchParams.infants = infants.toString();
    if (travelClass) searchParams.travelClass = travelClass;
    if (nonStop !== undefined) searchParams.nonStop = nonStop;
    if (currencyCode) searchParams.currencyCode = currencyCode;

    // Call Amadeus API via SDK
    const response = await amadeus.shopping.flightOffersSearch.get(searchParams);

    console.log(`✅ Found ${response.data.length} flight offers`);

    res.json({
      success: true,
      data: response.data,
      dictionaries: response.result.dictionaries,
      meta: response.result.meta,
    });

  } catch (error) {
    console.error('❌ Flight search error:', error);

    // Handle Amadeus-specific errors
    if (error.response) {
      const amadeusError = error.response.result?.errors?.[0];
      
      if (amadeusError) {
        return res.status(error.response.statusCode || 500).json({
          success: false,
          message: amadeusError.title || 'Search failed',
          errors: error.response.result.errors,
        });
      }
    }

    // Generic error
    res.status(500).json({
      success: false,
      message: 'Failed to search flights',
      errors: [{
        status: 500,
        code: 141,
        title: 'SYSTEM ERROR HAS OCCURRED',
        detail: error.message
      }]
    });
  }
};

// ============================================
// FLIGHT INSPIRATION SEARCH (Popular Routes)
// ============================================

/**
 * Get flight inspiration / popular routes
 * @route GET /api/flights/inspiration
 * @access Public
 */
exports.getFlightInspiration = async (req, res) => {
  try {
    const { origin, departureDate, oneWay, duration, maxPrice } = req.query;

    if (!origin) {
      return res.status(400).json({
        success: false,
        message: 'Origin is required',
      });
    }

    console.log('💡 Getting flight inspiration from:', origin);

    const searchParams = { origin };

    if (departureDate) searchParams.departureDate = departureDate;
    if (oneWay !== undefined) searchParams.oneWay = oneWay === 'true';
    if (duration) searchParams.duration = duration;
    if (maxPrice) searchParams.maxPrice = maxPrice;

    const response = await amadeus.shopping.flightDestinations.get(searchParams);

    res.json({
      success: true,
      data: response.data,
      meta: response.result.meta,
    });

  } catch (error) {
    console.error('❌ Flight inspiration error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get flight inspiration',
      error: error.description || error.message,
    });
  }
};

// ============================================
// FLIGHT OFFERS PRICE CONFIRMATION
// ============================================

/**
 * Confirm price and availability of flight offers
 * @route POST /api/flights/price-confirm
 * @access Public
 * @body {
 *   data: {
 *     type: 'flight-offers-pricing',
 *     flightOffers: [flightOffer1, flightOffer2, ...]
 *   }
 * }
 */
exports.confirmFlightPrice = async (req, res) => {
  try {
    const { data } = req.body;

    // Validate request structure
    if (!data || !data.flightOffers || !Array.isArray(data.flightOffers)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request structure',
        errors: [{
          status: 400,
          code: 477,
          title: 'INVALID FORMAT',
          detail: 'Request must contain data.flightOffers array',
          source: {
            parameter: 'data.flightOffers',
            example: '{ data: { type: "flight-offers-pricing", flightOffers: [...] } }'
          }
        }]
      });
    }

    console.log('💰 Confirming price for', data.flightOffers.length, 'flight offer(s)...');

    // Call Amadeus API
    const response = await amadeus.shopping.flightOffersSearch.pricing.post(
      JSON.stringify({
        data: {
          type: 'flight-offers-pricing',
          flightOffers: data.flightOffers,
        },
      })
    );

    console.log('✅ Price confirmed');

    // Return response in PayFlex format
    res.json({
      success: true,
      data: {
        type: response.data.type,
        flightOffers: response.data.flightOffers,
      },
      dictionaries: response.result.dictionaries,
      meta: response.result.meta,
    });

  } catch (error) {
    console.error('❌ Price confirmation error:', error);

    // Handle Amadeus-specific errors
    if (error.response) {
      const amadeusError = error.response.result?.errors?.[0];
      
      if (amadeusError) {
        return res.status(error.response.statusCode || 500).json({
          success: false,
          message: amadeusError.title || 'Price confirmation failed',
          errors: error.response.result.errors,
        });
      }
    }

    // Generic error
    res.status(500).json({
      success: false,
      message: 'Failed to confirm price',
      errors: [{
        status: 500,
        code: 141,
        title: 'SYSTEM ERROR HAS OCCURRED',
        detail: error.message
      }]
    });
  }
};

// ============================================
// SEATMAP DISPLAY
// ============================================

/**
 * Get seatmap for a flight offer (before booking)
 * @route POST /api/flights/seatmap
 * @access Public
 * @body {
 *   flightOffers: [flightOffer]  // The flight offer object from search
 * }
 */
exports.getFlightSeatmap = async (req, res) => {
  try {
    const { flightOffers } = req.body;

    if (!flightOffers || !Array.isArray(flightOffers) || flightOffers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Flight offer is required',
        errors: [{
          status: 400,
          code: 477,
          title: 'INVALID FORMAT',
          detail: 'flightOffers array with at least one flight offer is required',
          source: {
            parameter: 'flightOffers',
            example: '{ flightOffers: [flightOfferObject] }'
          }
        }]
      });
    }

    console.log('💺 Getting seatmap for flight offer...');

    // Call Amadeus Seatmap API
    const response = await amadeus.shopping.seatmaps.post(
      JSON.stringify({
        data: flightOffers
      })
    );

    console.log('✅ Seatmap retrieved');

    res.json({
      success: true,
      data: response.data,
      dictionaries: response.result.dictionaries,
    });

  } catch (error) {
    console.error('❌ Seatmap error:', error);

    // Handle Amadeus-specific errors
    if (error.response) {
      const amadeusError = error.response.result?.errors?.[0];
      
      if (amadeusError) {
        return res.status(error.response.statusCode || 500).json({
          success: false,
          message: amadeusError.title || 'Failed to get seatmap',
          errors: error.response.result.errors,
        });
      }
    }

    // Generic error
    res.status(500).json({
      success: false,
      message: 'Failed to get seatmap',
      errors: [{
        status: 500,
        code: 141,
        title: 'SYSTEM ERROR HAS OCCURRED',
        detail: error.message
      }]
    });
  }
};

/**
 * Get seatmap for an existing flight order (after booking)
 * @route GET /api/flights/seatmap/:orderId
 * @access Private
 */
exports.getSeatmapByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Order ID is required',
      });
    }

    console.log('💺 Getting seatmap for order:', orderId);

    // Call Amadeus Seatmap API with order ID
    const response = await amadeus.shopping.seatmaps.get({
      'flight-orderId': orderId
    });

    console.log('✅ Seatmap retrieved for order');

    res.json({
      success: true,
      data: response.data,
      dictionaries: response.result.dictionaries,
    });

  } catch (error) {
    console.error('❌ Seatmap error:', error);

    // Handle Amadeus-specific errors
    if (error.response) {
      const amadeusError = error.response.result?.errors?.[0];
      
      if (amadeusError) {
        return res.status(error.response.statusCode || 500).json({
          success: false,
          message: amadeusError.title || 'Failed to get seatmap',
          errors: error.response.result.errors,
        });
      }
    }

    // Generic error
    res.status(500).json({
      success: false,
      message: 'Failed to get seatmap',
      errors: [{
        status: 500,
        code: 141,
        title: 'SYSTEM ERROR HAS OCCURRED',
        detail: error.message
      }]
    });
  }
};

// ============================================
// FLIGHT CREATE ORDER (BOOKING)
// ============================================

/**
 * Create flight booking order
 * @route POST /api/flights/book
 * @access Private
 */
exports.createFlightOrder = async (req, res) => {
  try {
    const userId = req.user._id;
    const { flightOffers, travelers, contacts, remarks } = req.body;

    // Validate required fields
    if (!flightOffers || !travelers || !contacts) {
      return res.status(400).json({
        success: false,
        message: 'Flight offers, travelers and contact information are required',
      });
    }

    console.log('📝 Creating flight order for user:', userId);

    // Create order with Amadeus
    const response = await amadeus.booking.flightOrders.post(
      JSON.stringify({
        data: {
          type: 'flight-order',
          flightOffers: flightOffers,
          travelers: travelers,
          contacts: contacts,
          remarks: remarks,
        },
      })
    );

    console.log('✅ Flight order created:', response.data.id);

    // TODO: Save booking to database
    // const flightBooking = await FlightBooking.create({
    //   userId,
    //   amadeusOrderId: response.data.id,
    //   ...response.data,
    // });

    res.status(201).json({
      success: true,
      message: 'Flight booking created successfully',
      data: response.data,
    });

  } catch (error) {
    console.error('❌ Flight order creation error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to create flight order',
      error: error.description || error.message,
    });
  }
};

// ============================================
// FLIGHT ORDER MANAGEMENT
// ============================================

/**
 * Get flight order details
 * @route GET /api/flights/orders/:orderId
 * @access Private
 */
exports.getFlightOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    console.log('📋 Retrieving flight order:', orderId);

    const response = await amadeus.booking.flightOrder(orderId).get();

    res.json({
      success: true,
      data: response.data,
    });

  } catch (error) {
    console.error('❌ Flight order retrieval error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve flight order',
      error: error.description || error.message,
    });
  }
};

/**
 * Cancel flight order
 * @route DELETE /api/flights/orders/:orderId
 * @access Private
 */
exports.cancelFlightOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    console.log('❌ Cancelling flight order:', orderId);

    const response = await amadeus.booking.flightOrder(orderId).delete();

    console.log('✅ Flight order cancelled');

    // TODO: Update booking status in database

    res.json({
      success: true,
      message: 'Flight order cancelled successfully',
      data: response.data,
    });

  } catch (error) {
    console.error('❌ Flight order cancellation error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel flight order',
      error: error.description || error.message,
    });
  }
};

// ============================================
// FLIGHT CHECK-IN LINKS
// ============================================

/**
 * Get check-in links for an airline
 * @route GET /api/flights/checkin-links
 * @access Public
 */
exports.getCheckinLinks = async (req, res) => {
  try {
    const { airlineCode } = req.query;

    if (!airlineCode) {
      return res.status(400).json({
        success: false,
        message: 'Airline code is required',
      });
    }

    console.log('🔗 Getting check-in link for airline:', airlineCode);

    const response = await amadeus.referenceData.urls.checkinLinks.get({
      airlineCode: airlineCode,
    });

    res.json({
      success: true,
      data: response.data,
    });

  } catch (error) {
    console.error('❌ Check-in links error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get check-in links',
      error: error.description || error.message,
    });
  }
};

// ============================================
// ON-DEMAND FLIGHT STATUS
// ============================================

/**
 * Get real-time flight status
 * @route GET /api/flights/status
 * @access Public
 */
exports.getFlightStatus = async (req, res) => {
  try {
    const { flightNumber, flightDate } = req.query;

    if (!flightNumber || !flightDate) {
      return res.status(400).json({
        success: false,
        message: 'Flight number and date are required',
      });
    }

    console.log('🛫 Getting flight status:', flightNumber, flightDate);

    // Extract carrier code and flight number
    // Example: BA123 -> carrier: BA, number: 123
    const carrierCode = flightNumber.match(/[A-Z]+/)[0];
    const number = flightNumber.match(/\d+/)[0];

    const response = await amadeus.schedule.flights.get({
      carrierCode: carrierCode,
      flightNumber: number,
      scheduledDepartureDate: flightDate,
    });

    res.json({
      success: true,
      data: response.data,
    });

  } catch (error) {
    console.error('❌ Flight status error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get flight status',
      error: error.description || error.message,
    });
  }
};

// ============================================
// PASSENGER PROFILE CONTROLLERS (SHARED)
// ============================================

/**
 * Get user's saved passenger profiles
 * Same profiles used for both transport and flight bookings
 * @route GET /api/flights/passengers/profiles
 * @access Private
 */
exports.getPassengerProfiles = async (req, res) => {
  try {
    const userId = req.user._id;
    const profiles = await getUserProfiles(userId);

    res.json({
      success: true,
      data: profiles,
    });
  } catch (error) {
    console.error('❌ Error getting passenger profiles:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get passenger profiles',
      error: error.message,
    });
  }
};

/**
 * Search passenger profile by phone number (for auto-fill)
 * Same profiles used for both transport and flight bookings
 * @route GET /api/flights/passengers/search/:phone
 * @access Private
 */
exports.searchPassengerByPhone = async (req, res) => {
  try {
    const userId = req.user._id;
    const { phone } = req.params;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required',
      });
    }

    console.log('🔍 Searching passenger profile by phone:', phone);

    const profile = await searchPassenger(userId, phone);

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'No saved passenger found with this phone number',
      });
    }

    console.log('✅ Found saved passenger profile');

    res.json({
      success: true,
      data: profile,
    });
  } catch (error) {
    console.error('❌ Error searching passenger:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search passenger',
      error: error.message,
    });
  }
};