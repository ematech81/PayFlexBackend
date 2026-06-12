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
    console.log(`[merpi] ${type} request payload:`, JSON.stringify({ ...ticketData, reference }));
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
    console.error(`[merpi] ${type} MERPI error response body:`, JSON.stringify(err.response?.data));

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

// Buses are the physical vehicles assigned to a schedule — fetched via path param
const getBuses = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/transport/buses/${req.params.schedule_id}`);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getBuses:', merpiErrMsg(err));
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

// V2 "packages" endpoint — for random schedules this is the only source of
// schedule.operating_hours and schedule.buses[] (bus_id + start_time/end_time
// per bus), which the v1 /schedules endpoint does not return.
const getSchedulePackages = async (req, res) => {
  try {
    const { route_id, departure_date, from_city_id, to_city_id, business_id, terminal_id } = req.query;
    const { data } = await merpi.get('/v2/merpi/transport/schedules/packages', {
      params: { route_id, departure_date, from_city_id, to_city_id, business_id, terminal_id },
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getSchedulePackages:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getSeats = async (req, res) => {
  try {
    const { schedule_id, bus_id, departure_date } = req.params;
    const { data } = await merpi.get(
      `/v1/merpi/transport/bus/seats/${schedule_id}/${bus_id}/${departure_date}`
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('[merpi] getSeats:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const buyBusTicket = (req, res) =>
  buyTicket({ req, res, type: 'bus_ticket', merpiPath: '/v2/merpi/transport/buy/tickets' });

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
// Cinema experiences share the /v1/merpi/experience endpoints with cinema=true.
// Scope: daily and weekly cinemas only (monthly is not supported).

const getMovies = async (req, res) => {
  try {
    const { data } = await merpi.get('/v1/merpi/experience', {
      params: { ...req.query, cinema: true },
    });
    res.json({ success: true, data: data.data });
  } catch (err) {
    console.error('[merpi] getMovies:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getCinemaDetails = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/experience/v/${req.params.id}`);
    res.json({ success: true, data: data.data });
  } catch (err) {
    console.error('[merpi] getCinemaDetails:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const MONTH_NAME_TO_NUM = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const isInvalidMonthErr = (err) => err.response?.status === 400 && !!err.response?.data?.errors?.month;

const getAvailableDates = async (req, res) => {
  const { id, month } = req.params;
  const monthNum = MONTH_NAME_TO_NUM[month.toLowerCase()];

  // The MERPI docs say `month` should be a capitalized name (e.g. "January"),
  // but the live API rejects that as "The selected month is invalid." —
  // try lowercase name, then numeric month, as fallbacks.
  const candidates = [month, month.toLowerCase(), monthNum].filter(
    (v, i, arr) => v != null && arr.indexOf(v) === i
  );

  let lastErr;
  for (const candidate of candidates) {
    try {
      const { data } = await merpi.get(`/v1/merpi/experience/cinema/dates/${id}/${candidate}`);
      return res.json({ success: true, data: data.data });
    } catch (err) {
      lastErr = err;
      console.error('[merpi] getAvailableDates failed for month', JSON.stringify(candidate),
        '-> status', err.response?.status, 'body', JSON.stringify(err.response?.data));
      if (!isInvalidMonthErr(err)) break;
    }
  }

  return res.status(lastErr.response?.status || 502).json({ success: false, message: merpiErrMsg(lastErr) });
};

const getCinemaTicketTypes = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v1/merpi/experience/tickets/${req.params.id}`, {
      params: { cinema_location_id: req.query.cinema_location_id },
    });
    res.json({ success: true, data: data.data });
  } catch (err) {
    console.error('[merpi] getCinemaTicketTypes:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

// "YYYY-MM-DD" -> "DD-MM-YYYY" (MERPI buy endpoint expects DD-MM-YYYY)
function toDDMMYYYY(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}-${month}-${year}`;
}

const buyCinemaTickets = async (req, res) => {
  const userId = req.user.id || req.user._id;
  const {
    experience_id,
    cinema_location_id,
    attendance_date,
    time_id,
    tickets,
    amount,
  } = req.body;

  if (!experience_id) {
    return res.status(400).json({ success: false, message: 'experience_id is required.' });
  }
  if (!attendance_date) {
    return res.status(400).json({ success: false, message: 'attendance_date is required for cinema tickets.' });
  }
  if (!time_id) {
    return res.status(400).json({ success: false, message: 'time_id is required.' });
  }
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one ticket is required.' });
  }

  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) {
    return res.status(400).json({ success: false, message: 'Valid amount is required.' });
  }

  let user;
  try {
    user = await User.findById(userId).select('+walletBalance');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    validateWalletBalance(user, numAmount);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const customerInfo = {
    name:         user.fullName,
    email:        user.email,
    phone_number: (user.phone || '').replace(/\D/g, ''),
  };

  const reference = genRef('CINEMATICKET');
  let txn = null;

  // Phase 1 — deduct wallet + create pending record
  try {
    await deductWalletBalance(user, numAmount);

    txn = await MerpiTransaction.create({
      userId,
      type: 'cinema_ticket',
      reference,
      amount: numAmount,
      status: 'pending',
      walletDeducted: true,
    });
  } catch (err) {
    console.error('[merpi] cinema_ticket DB phase failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not initiate booking. Please try again.' });
  }

  let reservationIds;

  // Phase 2a — hold inventory
  try {
    const holdPayload = {
      tickets: tickets.map((t) => ({
        ticket_type: 'entertainment',
        resource_id: t.id,
        quantity:    t.count,
      })),
      customer_info: {
        email:        customerInfo.email,
        phone_number: customerInfo.phone_number,
      },
    };

    console.log('[merpi] cinema_ticket hold payload:', JSON.stringify(holdPayload));
    const { data } = await merpi.post('/v1/merpi/validate', holdPayload);
    console.log('[merpi] cinema_ticket hold response:', JSON.stringify(data));
    reservationIds = data.data.reservations.map((r) => r.reservation_id);
  } catch (err) {
    console.error('[merpi] cinema_ticket hold failed -> status', err.response?.status, 'body', JSON.stringify(err.response?.data));
    await refundWalletBalance(user, numAmount).catch((re) =>
      console.error('[merpi] cinema_ticket refund failed:', re.message)
    );
    await MerpiTransaction.findByIdAndUpdate(txn._id, {
      status: 'failed',
      bookingDetails: err.response?.data ?? { error: err.message },
    }).catch(() => {});

    return res.status(err.response?.status || 502).json({
      success: false,
      message: merpiErrMsg(err),
    });
  }

  // Phase 2b — confirm booking
  try {
    const buyPayload = {
      reservation_ids: reservationIds,
      tickets,
      experience_id,
      ...(cinema_location_id ? { cinema_location_id } : {}),
      attendance_date: toDDMMYYYY(attendance_date),
      time_id,
      customer_info: customerInfo,
    };

    console.log('[merpi] cinema_ticket buy payload:', JSON.stringify(buyPayload));
    const { data } = await merpi.post('/v1/merpi/experience/buy/tickets', buyPayload);
    console.log('[merpi] cinema_ticket buy response:', JSON.stringify(data));

    await MerpiTransaction.findByIdAndUpdate(txn._id, {
      status: 'confirmed',
      bookingDetails: data.data,
    }).catch(() => {});

    return res.json({
      success:    true,
      reference:  data.data.reference,
      booking:    data.data,
      newBalance: user.walletBalance,
    });
  } catch (err) {
    console.error('[merpi] cinema_ticket buy failed -> status', err.response?.status, 'body', JSON.stringify(err.response?.data));
    await refundWalletBalance(user, numAmount).catch((re) =>
      console.error('[merpi] cinema_ticket refund failed:', re.message)
    );
    await MerpiTransaction.findByIdAndUpdate(txn._id, {
      status: 'failed',
      bookingDetails: err.response?.data ?? { error: err.message },
    }).catch(() => {});

    return res.status(err.response?.status || 502).json({
      success: false,
      message: merpiErrMsg(err),
    });
  }
};

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
  getStates, getCities, getRoutes, getBuses,
  getSchedules, getSchedulePackages, getSeats, buyBusTicket,
  // Events
  getExperiences, getExperienceDetails, getExperienceTickets, buyExperienceTickets,
  // Cinema
  getMovies, getCinemaDetails, getAvailableDates, getCinemaTicketTypes, buyCinemaTickets,
  // General
  getCategories, getBusinesses, getTransaction,
};
