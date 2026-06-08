'use strict';

const merpi            = require('../services/merpiService');
const MerpiTransaction = require('../models/merpiTransaction');
const User             = require('../models/user');
const {
  validateWalletBalance,
  deductWalletBalance,
  refundWalletBalance,
} = require('../util/paymentHelper');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genRef(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}

function merpiErrMsg(err) {
  return err.response?.data?.message || err.response?.data?.error || err.message || 'MERPI request failed';
}

function isDeprecated(err, data) {
  const msg = (data?.message || data?.error || err?.message || '').toLowerCase();
  return (
    err?.response?.status === 410 ||
    msg.includes('deprecated') ||
    msg.includes('v1') && msg.includes('not supported')
  );
}

async function buyTicket({ req, res, type, merpiPath, extraValidate }) {
  const userId = req.user.id || req.user._id;

  // Extra validation before touching wallet (e.g. attendance_date for cinema)
  if (extraValidate) {
    const validationError = extraValidate(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
  }

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Valid amount is required.' });
  }

  let user;
  try {
    user = await User.findById(userId).select('+walletBalance');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    validateWalletBalance(user, amount);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const reference = genRef(type.toUpperCase().replace('_', ''));
  let txn = null;

  // Phase 1 — deduct wallet + create pending record
  try {
    await deductWalletBalance(user, amount);

    txn = await MerpiTransaction.create({
      userId,
      type,
      reference,
      amount,
      status: 'pending',
      walletDeducted: true,
    });
  } catch (err) {
    // If wallet was already deducted before error, refund
    if (txn === null && user.walletBalance !== undefined) {
      await refundWalletBalance(user, amount).catch(() => {});
    }
    console.error(`[merpi] ${type} DB phase failed:`, err.message);
    return res.status(500).json({ success: false, message: 'Could not initiate booking. Please try again.' });
  }

  // Phase 2 — call MERPI API
  try {
    const { pin, amount: _amt, ...ticketData } = req.body;
    const merpiRes = await merpi.post(merpiPath, { ...ticketData, reference });
    const data = merpiRes.data;

    // V1 deprecation guard
    if (isDeprecated(null, data)) {
      console.warn(`[merpi] ${type}: V1 endpoint deprecated response`);
      await refundWalletBalance(user, amount).catch(() => {});
      await MerpiTransaction.findByIdAndUpdate(txn._id, { status: 'failed', bookingDetails: data }).catch(() => {});
      return res.json({
        success: false,
        message: 'Bus booking temporarily unavailable. Please try again later.',
      });
    }

    await MerpiTransaction.findByIdAndUpdate(txn._id, {
      status: 'confirmed',
      bookingDetails: data,
    }).catch(() => {});

    return res.json({
      success:   true,
      reference,
      booking:   data,
      newBalance: user.walletBalance,
    });

  } catch (err) {
    console.error(`[merpi] ${type} MERPI call failed:`, merpiErrMsg(err));

    await refundWalletBalance(user, amount).catch((re) =>
      console.error(`[merpi] ${type} refund failed:`, re.message)
    );
    await MerpiTransaction.findByIdAndUpdate(txn._id, {
      status: 'failed',
      bookingDetails: err.response?.data ?? { error: err.message },
    }).catch(() => {});

    if (isDeprecated(err, err.response?.data)) {
      return res.json({
        success: false,
        message: 'Bus booking temporarily unavailable. Please try again later.',
      });
    }

    return res.status(err.response?.status || 502).json({
      success: false,
      message: merpiErrMsg(err),
    });
  }
}

// ─── BUS / TRANSPORT ─────────────────────────────────────────────────────────
// Confirmed base: https://merpi.syticks.com/api
// All transport paths: /v1/merpi/transport/...

const getStates = async (req, res) => {
  try {
    const { data } = await merpi.get('/v1/merpi/transport/states', { params: req.query });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getStates:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getCities = async (req, res) => {
  try {
    const { data } = await merpi.get('/v1/merpi/transport/cities', { params: req.query });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getCities:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getRoutes = async (req, res) => {
  try {
    const { from_city_id, to_city_id, price, business_id, search } = req.query;
    const { data } = await merpi.get('/v2/merpi/transport/routes', {
      params: { from_city_id, to_city_id, price, business_id, search },
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getRoutes:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getBuses = async (req, res) => {
  try {
    const { route_id, schedule_id, departure_date } = req.query;
    const { data } = await merpi.get('/v1/merpi/transport/buses', { params: { route_id, schedule_id, departure_date } });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getBuses:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getSingleBus = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/transport/buses/${req.params.bus_id}`);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getSingleBus:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getSchedules = async (req, res) => {
  try {
    const { route_id, terminal_id, date } = req.query;
    const { data } = await merpi.get('/v1/merpi/transport/schedules', { params: { route_id, terminal_id, date } });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getSchedules:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getSeats = async (req, res) => {
  try {
    const { bus_id, schedule_id } = req.query;
    const { data } = await merpi.get('/v1/merpi/transport/seats', { params: { bus_id, schedule_id } });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getSeats:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const buyBusTicket = (req, res) =>
  buyTicket({ req, res, type: 'bus_ticket', merpiPath: '/v1/merpi/transport/tickets/buy' });

// ─── EVENTS / EXPERIENCES ────────────────────────────────────────────────────
// Inferred path: /v1/merpi/experiences/... — update if docs show different

const getExperiences = async (req, res) => {
  try {
    const { data } = await merpi.get('/v1/merpi/experiences', { params: req.query });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getExperiences:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getExperienceDetails = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/experiences/${req.params.id}`);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getExperienceDetails:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getExperienceTickets = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/experiences/${req.params.id}/tickets`);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getExperienceTickets:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const buyExperienceTickets = (req, res) =>
  buyTicket({ req, res, type: 'event_ticket', merpiPath: '/v1/merpi/experiences/tickets/buy' });

// ─── CINEMA ───────────────────────────────────────────────────────────────────
// Inferred path: /v1/merpi/cinema/... — update if docs show different

const getMovies = async (req, res) => {
  try {
    const { data } = await merpi.get('/v1/merpi/cinema', { params: req.query });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getMovies:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getCinemaDetails = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/cinema/${req.params.id}`);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getCinemaDetails:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getAvailableDates = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/cinema/${req.params.id}/dates`);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getAvailableDates:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getCinemaTicketTypes = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/cinema/${req.params.id}/tickets`);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getCinemaTicketTypes:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const buyCinemaTickets = (req, res) =>
  buyTicket({
    req,
    res,
    type: 'cinema_ticket',
    merpiPath: '/v1/merpi/cinema/tickets/buy',
    extraValidate: (body) => {
      if (!body.attendance_date) return 'attendance_date is required for cinema tickets.';
      return null;
    },
  });

// ─── GENERAL ──────────────────────────────────────────────────────────────────

const getCategories = async (req, res) => {
  try {
    const { data } = await merpi.get('/v1/merpi/categories');
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getCategories:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getBusinesses = async (req, res) => {
  try {
    const { data } = await merpi.get('/v1/merpi/businesses', { params: req.query });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getBusinesses:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getTransaction = async (req, res) => {
  try {
    // Check local DB first — fall back to MERPI API
    const local = await MerpiTransaction.findOne({
      reference: req.params.reference,
      userId:    req.user.id || req.user._id,
    }).lean();

    let merpiData = null;
    try {
      const { data } = await merpi.get(`/v1/merpi/transactions/${req.params.reference}`);
      merpiData = data;
      // Sync status from MERPI if local record exists
      if (local && merpiData?.status && local.status !== merpiData.status) {
        await MerpiTransaction.findByIdAndUpdate(local._id, {
          status:         merpiData.status,
          bookingDetails: merpiData,
        }).catch(() => {});
      }
    } catch {
      // MERPI query failure is non-fatal — return local record
    }

    if (!local && !merpiData) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    res.json({ success: true, local, merpiData });
  } catch (err) {
    console.error('[merpi] getTransaction:', err.message);
    res.status(500).json({ success: false, message: 'Could not retrieve transaction.' });
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Bus
  getStates, getCities, getRoutes, getBuses, getSingleBus,
  getSchedules, getSeats, buyBusTicket,
  // Events
  getExperiences, getExperienceDetails, getExperienceTickets, buyExperienceTickets,
  // Cinema
  getMovies, getCinemaDetails, getAvailableDates, getCinemaTicketTypes, buyCinemaTickets,
  // General
  getCategories, getBusinesses, getTransaction,
};
