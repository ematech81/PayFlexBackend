
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Booking = require('../models/booking');
const { 
  savePassengerProfiles, 
  getUserProfiles, 
  searchPassengerByPhone: searchPassenger 
} = require('../util/passengerProfile');

// ============================================
// CREATE BOOKING
// ============================================

exports.createBooking = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      tripDetails,
      passengers,
      payment,
      pin, // Transaction PIN
    } = req.body;

    console.log('🎫 Creating booking for user:', userId);

    // Validate required fields
    if (!tripDetails || !passengers || !payment || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      });
    }

    // Validate passengers
    if (!Array.isArray(passengers) || passengers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one passenger is required',
      });
    }

    // Get user with transaction PIN
    const user = await User.findById(userId).select('+transactionPinHash +walletBalance');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Verify transaction PIN
    const isPinValid = await user.validateTransactionPin(pin);
    if (!isPinValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid transaction PIN',
      });
    }

    // Check wallet balance
    if (user.walletBalance < payment.amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance',
      });
    }

    // Generate booking reference
    const bookingReference = Booking.generateBookingReference();

    // Mark first passenger as primary
    passengers[0].isPrimary = true;

    // Create booking
    const booking = await Booking.create({
      userId,
      bookingReference,
      status: 'pending',
      tripDetails: {
        provider: tripDetails.provider,
        tripId: tripDetails.tripId,
        tripNo: tripDetails.tripNo,
        route: `${tripDetails.origin} → ${tripDetails.destination}`,
        origin: tripDetails.origin,
        destination: tripDetails.destination,
        departureTerminal: tripDetails.departureTerminal,
        destinationTerminal: tripDetails.destinationTerminal,
        departureAddress: tripDetails.departureAddress,
        destinationAddress: tripDetails.destinationAddress,
        departureDate: tripDetails.departureDate,
        departureTime: tripDetails.departureTime,
        vehicle: tripDetails.vehicle,
        boardingAt: tripDetails.boardingAt,
        orderId: tripDetails.orderId,
      },
      passengers,
      payment: {
        amount: payment.amount,
        farePerSeat: payment.farePerSeat,
        totalSeats: passengers.length,
        serviceFee: payment.serviceFee || 0,
        method: payment.method || 'wallet',
        paidAt: new Date(),
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Deduct from wallet
    user.walletBalance -= payment.amount;
    await user.save();

    // Create transaction record
    const transaction = await Transaction.create({
      userId,
      type: 'transport_booking',
      amount: payment.amount,
      status: 'successful',
      description: `Transport booking: ${tripDetails.origin} → ${tripDetails.destination}`,
      reference: bookingReference,
      metadata: {
        bookingId: booking._id,
        provider: tripDetails.provider.name,
        passengers: passengers.length,
      },
    });

    // Link transaction to booking
    booking.payment.transactionId = transaction._id;

    // TODO: Make actual booking with Travu API
    // const travuBooking = await travuService.bookTrip({...});
    // booking.travuBookingId = travuBooking.data.booking_id;
    // booking.travuResponse = travuBooking.data;

    // Update booking status to confirmed (after Travu API success)
    booking.status = 'confirmed';
    await booking.save();

    // Save passenger profiles for future use
    await savePassengerProfiles(userId, passengers);

    console.log('✅ Booking created:', bookingReference);

    res.status(201).json({
      success: true,
      message: 'Booking successful',
      data: {
        bookingId: booking._id,
        bookingReference: booking.bookingReference,
        status: booking.status,
        amount: booking.payment.amount,
        passengers: booking.passengers.length,
        newWalletBalance: user.walletBalance,
      },
    });
  } catch (error) {
    console.error('❌ Create Booking Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: error.message,
    });
  }
};

// ============================================
// GET USER BOOKINGS
// ============================================

exports.getUserBookings = async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, page = 1, limit = 20 } = req.query;

    console.log('📋 Getting bookings for user:', userId);

    const query = { userId };
    if (status) {
      query.status = status;
    }

    const bookings = await Booking.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .select('-travuResponse -ipAddress -userAgent');

    const totalBookings = await Booking.countDocuments(query);

    res.json({
      success: true,
      data: {
        bookings,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalBookings,
          pages: Math.ceil(totalBookings / parseInt(limit)),
        },
      },
    });
  } catch (error) {
    console.error('❌ Get Bookings Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get bookings',
    });
  }
};

// ============================================
// GET SINGLE BOOKING
// ============================================

exports.getBooking = async (req, res) => {
  try {
    const userId = req.user._id;
    const { bookingId } = req.params;

    console.log('📄 Getting booking:', bookingId);

    const booking = await Booking.findOne({
      _id: bookingId,
      userId,
    }).select('-travuResponse -ipAddress -userAgent');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    res.json({
      success: true,
      data: booking,
    });
  } catch (error) {
    console.error('❌ Get Booking Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get booking',
    });
  }
};

// ============================================
// GET BOOKING BY REFERENCE
// ============================================

exports.getBookingByReference = async (req, res) => {
  try {
    const userId = req.user._id;
    const { reference } = req.params;

    console.log('🔍 Getting booking by reference:', reference);

    const booking = await Booking.findOne({
      bookingReference: reference.toUpperCase(),
      userId,
    }).select('-travuResponse -ipAddress -userAgent');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    res.json({
      success: true,
      data: booking,
    });
  } catch (error) {
    console.error('❌ Get Booking By Reference Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to get booking',
    });
  }
};

// ============================================
// CANCEL BOOKING
// ============================================

exports.cancelBooking = async (req, res) => {
  try {
    const userId = req.user._id;
    const { bookingId } = req.params;
    const { reason } = req.body;

    console.log('❌ Cancelling booking:', bookingId);

    const booking = await Booking.findOne({
      _id: bookingId,
      userId,
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    // Check if can be cancelled
    if (!booking.canBeCancelled()) {
      return res.status(400).json({
        success: false,
        message: 'Booking cannot be cancelled. Must be at least 2 hours before departure.',
      });
    }

    // TODO: Cancel with Travu API
    // await travuService.cancelBooking(booking.travuBookingId);

    // Calculate refund (80% of booking amount as cancellation fee policy)
    const refundAmount = booking.payment.amount * 0.8;

    // Update booking
    booking.status = 'cancelled';
    booking.cancellation = {
      reason: reason || 'User requested cancellation',
      cancelledAt: new Date(),
      refundAmount,
      refundStatus: 'pending',
    };
    await booking.save();

    // Refund to wallet
    const user = await User.findById(userId);
    user.walletBalance += refundAmount;
    await user.save();

    // Create refund transaction
    await Transaction.create({
      userId,
      type: 'transport_refund',
      amount: refundAmount,
      status: 'successful',
      description: `Refund for cancelled booking: ${booking.bookingReference}`,
      reference: `REF_${booking.bookingReference}`,
      metadata: {
        bookingId: booking._id,
        originalAmount: booking.payment.amount,
      },
    });

    booking.cancellation.refundStatus = 'processed';
    await booking.save();

    console.log('✅ Booking cancelled and refunded');

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      data: {
        refundAmount,
        newWalletBalance: user.walletBalance,
      },
    });
  } catch (error) {
    console.error('❌ Cancel Booking Error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel booking',
    });
  }
};


// ============================================
// PASSENGER PROFILE CONTROLLERS
// ============================================

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

    const profile = await searchPassenger(userId, phone);

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'No saved passenger found with this phone number',
      });
    }

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