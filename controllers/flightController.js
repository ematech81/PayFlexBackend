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
// FLIGHT CREATE ORDER (BOOKING) - REFACTORED
// ============================================
 
/**
 * Create flight booking order with payment
 * @route POST /api/flights/book
 * @access Private
 * @body {
 *   data: {
 *     type: 'flight-order',
 *     flightOffers: [flightOffer],
 *     travelers: [traveler1, traveler2, ...],
 *     contacts: [contact],
 *     remarks: { general: [...] },
 *     ticketingAgreement: { option: 'DELAY_TO_CANCEL', delay: '6D' }
 *   },
 *   payment: {
 *     method: 'wallet',
 *     amount: 45000,
 *     currency: 'NGN'
 *   },
 *   pin: '1234'
 * }
 */
exports.createFlightBooking = async (req, res) => {
  try {
    const userId = req.user._id;
    const { data, payment, pin } = req.body;
 
    console.log('📝 Creating flight booking for user:', userId);
 
    // Validate required fields
    if (!data || !data.flightOffers || !data.travelers || !data.contacts) {
      return res.status(400).json({
        success: false,
        message: 'Flight offers, travelers and contact information are required',
        errors: [{
          status: 400,
          code: 477,
          title: 'INVALID FORMAT',
          detail: 'Missing required fields: data.flightOffers, data.travelers, data.contacts',
        }]
      });
    }
 
    if (!payment || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Payment information and PIN are required',
      });
    }
 
    // ============================================
    // USE CENTRALIZED PAYMENT HELPER
    // ============================================
 
    // 1. Verify user and PIN
    const user = await verifyUserAndPin(req, pin);
 
    // 2. Process payment with automatic rollback
    const result = await processPaymentWithRollback({
      user,
      amount: payment.amount,
      type: 'flight_booking',
      transactionData: {
        bookingType: 'flight',
        currency: payment.currency || 'NGN',
        paymentMethod: payment.method || 'wallet',
      },
      paymentOperation: async (transaction, session) => {
        // Generate booking reference
        const bookingReference = `FL-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
 
        // Call Amadeus Flight Create Orders API
        console.log('📞 Calling Amadeus Flight Create Orders...');
        
        const amadeusResponse = await amadeus.booking.flightOrders.post(
          JSON.stringify({
            data: {
              type: 'flight-order',
              flightOffers: data.flightOffers,
              travelers: data.travelers,
              contacts: data.contacts,
              remarks: data.remarks || {
                general: [{
                  subType: 'GENERAL_MISCELLANEOUS',
                  text: 'PayFlex Booking',
                }],
              },
              ticketingAgreement: data.ticketingAgreement || {
                option: 'DELAY_TO_CANCEL',
                delay: '6D',
              },
            },
          })
        );
 
        console.log('✅ Amadeus booking created:', amadeusResponse.data.id);
 
        const amadeusOrderId = amadeusResponse.data.id;
        const pnr = amadeusResponse.data.associatedRecords?.[0]?.reference || bookingReference;
 
        // Save passengers to database
        const savedPassengerIds = [];
        for (const traveler of data.travelers) {
          const passengerData = {
            userId,
            firstName: traveler.name.firstName,
            lastName: traveler.name.lastName,
            dateOfBirth: traveler.dateOfBirth,
            gender: traveler.gender,
            email: traveler.contact?.emailAddress,
            phoneNumber: traveler.contact?.phones?.[0]?.number,
          };
 
          // Add passport info if available
          if (traveler.documents && traveler.documents.length > 0) {
            const passport = traveler.documents[0];
            passengerData.passportNumber = passport.number;
            passengerData.passportExpiry = passport.expiryDate;
            passengerData.nationality = passport.nationality;
          }
 
          const passenger = await PassengerProfile.create([passengerData], { session });
          savedPassengerIds.push(passenger[0]._id);
        }
 
        // Extract flight details for storage
        const flightOffer = data.flightOffers[0];
        const firstSegment = flightOffer.itineraries?.[0]?.segments?.[0];
        const lastSegment = flightOffer.itineraries?.[0]?.segments?.[
          flightOffer.itineraries[0].segments.length - 1
        ];
 
        // Extract selected seats if any
        const selectedSeats = {};
        flightOffer.travelerPricings?.forEach((pricing) => {
          pricing.fareDetailsBySegment?.forEach((segment) => {
            const seatNumber = segment.additionalServices?.chargeableSeatNumber;
            if (seatNumber) {
              selectedSeats[pricing.travelerId] = seatNumber;
            }
          });
        });
 
        // Create flight booking record
        const booking = await FlightBooking.create([{
          userId,
          bookingReference,
          amadeusOrderId,
          pnr,
          status: 'confirmed',
          flight: {
            origin: firstSegment?.departure?.iataCode,
            destination: lastSegment?.arrival?.iataCode,
            departureDate: firstSegment?.departure?.at,
            arrivalDate: lastSegment?.arrival?.at,
            airline: flightOffer.validatingAirlineCodes?.[0],
            flightNumber: firstSegment?.number,
            aircraft: firstSegment?.aircraft?.code,
            cabin: flightOffer.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin,
          },
          passengers: savedPassengerIds,
          selectedSeats,
          totalAmount: payment.amount,
          currency: payment.currency || 'NGN',
          payment: {
            amount: payment.amount,
            currency: payment.currency || 'NGN',
            method: payment.method || 'wallet',
            paidAt: new Date(),
            transactionId: transaction._id,
          },
          amadeusResponse: amadeusResponse.data, // Store full Amadeus response
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        }], { session });
 
        // Update transaction with booking details
        transaction.bookingReference = bookingReference;
        transaction.bookingId = booking[0]._id;
        transaction.metadata = {
          amadeusOrderId,
          pnr,
          route: `${firstSegment?.departure?.iataCode} → ${lastSegment?.arrival?.iataCode}`,
          airline: flightOffer.validatingAirlineCodes?.[0],
          passengers: data.travelers.length,
          departureDate: firstSegment?.departure?.at,
        };
        await transaction.save({ session });
 
        // Save passenger profiles for future use
        await savePassengerProfiles(userId, data.travelers.map((t, index) => ({
          firstName: t.name.firstName,
          lastName: t.name.lastName,
          dateOfBirth: t.dateOfBirth,
          gender: t.gender,
          email: t.contact?.emailAddress,
          phoneNumber: t.contact?.phones?.[0]?.number,
          passportNumber: t.documents?.[0]?.number,
          passportExpiry: t.documents?.[0]?.expiryDate,
          nationality: t.documents?.[0]?.nationality,
        })));
 
        console.log('✅ Flight booking created:', bookingReference);
        console.log('✅ Transaction created:', transaction.reference);
 
        return {
          success: true,
          status: 'completed',
          transactionId: transaction.reference,
          response: {
            bookingId: booking[0]._id,
            bookingReference,
            amadeusOrderId,
            pnr,
            status: 'confirmed',
          },
        };
      },
      useMongoTransaction: true, // ✅ Use MongoDB transactions for safety
    });
 
    // 3. Return success response
    res.status(201).json({
      success: true,
      message: 'Flight booked successfully',
      data: {
        bookingId: result.response.bookingId,
        bookingReference: result.response.bookingReference,
        amadeusOrderId: result.response.amadeusOrderId,
        pnr: result.response.pnr,
        transactionReference: result.transaction.reference,
        status: result.response.status,
        amount: payment.amount,
        currency: payment.currency || 'NGN',
        newWalletBalance: result.newBalance,
      },
    });
 
  } catch (error) {
    console.error('❌ Flight Booking Error:', error.message);
    console.error('Stack:', error.stack);
 
    // Handle Amadeus-specific errors
    if (error.response?.result?.errors) {
      const amadeusError = error.response.result.errors[0];
      return res.status(error.response.statusCode || 500).json({
        success: false,
        message: amadeusError.title || 'Flight booking failed',
        errors: error.response.result.errors,
      });
    }
 
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create flight booking',
    });
  }
};


// ============================================
// CANCEL FLIGHT BOOKING - REFACTORED
// ============================================
 
/**
 * Cancel flight booking with refund
 * @route POST /api/flights/bookings/:bookingId/cancel
 * @access Private
 */
exports.cancelFlightBooking = async (req, res) => {
  try {
    const userId = req.user._id;
    const { bookingId } = req.params;
    const { reason } = req.body;
 
    console.log('❌ Cancelling flight booking:', bookingId);
 
    // Find booking
    const booking = await FlightBooking.findOne({
      _id: bookingId,
      userId,
    });
 
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }
 
    // Check if already cancelled
    if (booking.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Booking is already cancelled',
      });
    }
 
    // Check if can be cancelled (example: within ticketing agreement delay)
    const departureDate = new Date(booking.flight.departureDate);
    const now = new Date();
    const hoursUntilDeparture = (departureDate - now) / (1000 * 60 * 60);
 
    if (hoursUntilDeparture < 24) {
      return res.status(400).json({
        success: false,
        message: 'Booking cannot be cancelled. Must be at least 24 hours before departure.',
      });
    }
 
    // Cancel with Amadeus
    console.log('📞 Calling Amadeus to cancel order:', booking.amadeusOrderId);
    
    try {
      const amadeusResponse = await amadeus.booking.flightOrder(booking.amadeusOrderId).delete();
      console.log('✅ Amadeus order cancelled');
    } catch (amadeusError) {
      console.error('⚠️ Amadeus cancellation error:', amadeusError.message);
      // Continue with local cancellation even if Amadeus fails
      // (You might want to handle this differently based on your business logic)
    }
 
    // Calculate refund (example: 70% refund for cancellations)
    const refundPercentage = hoursUntilDeparture >= 72 ? 0.9 : 0.7; // 90% if >72hrs, 70% otherwise
    const refundAmount = booking.totalAmount * refundPercentage;
    const cancellationFee = booking.totalAmount - refundAmount;
 
    // Update booking
    booking.status = 'cancelled';
    booking.cancellation = {
      reason: reason || 'User requested cancellation',
      cancelledAt: new Date(),
      refundAmount,
      cancellationFee,
      refundStatus: 'pending',
    };
    await booking.save();
 
    // ✅ USE CENTRALIZED HELPER: Refund to wallet
    const user = await User.findById(userId).select('+walletBalance');
    const newBalance = await refundWalletBalance(user, refundAmount);
 
    // Create refund transaction
    const refundReference = `REF-${booking.bookingReference}-${Date.now()}`;
    
    await Transaction.create({
      userId,
      type: 'flight_refund',
      bookingType: 'flight',
      bookingReference: booking.bookingReference,
      bookingId: booking._id,
      amount: refundAmount,
      currency: booking.currency,
      reference: refundReference,
      status: 'completed',
      paymentMethod: 'wallet',
      metadata: {
        originalAmount: booking.totalAmount,
        cancellationFee,
        refundPercentage: refundPercentage * 100,
        reason: reason || 'User requested cancellation',
        amadeusOrderId: booking.amadeusOrderId,
      },
      paidAt: new Date(),
    });
 
    // Update cancellation status
    booking.cancellation.refundStatus = 'processed';
    await booking.save();
 
    console.log('✅ Flight booking cancelled and refunded');
 
    res.json({
      success: true,
      message: 'Flight booking cancelled successfully',
      data: {
        refundAmount,
        cancellationFee,
        refundPercentage: refundPercentage * 100,
        newWalletBalance: newBalance,
      },
    });
 
  } catch (error) {
    console.error('❌ Cancel Flight Booking Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel booking',
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