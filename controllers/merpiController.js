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

// MERPI cinema buy endpoint expects DD-MM-YYYY; the frontend sends YYYY-MM-DD.
function toMerpiDate(ymd) {
  if (!ymd) return ymd;
  if (/^\d{2}-\d{2}-\d{4}$/.test(ymd)) return ymd; // already DD-MM-YYYY
  const [y, m, d] = ymd.split('-');
  return `${d}-${m}-${y}`;
}

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

function isNotFoundErr(err) {
  return err.response?.status === 404;
}

// Normalize a Nigerian phone number to "234XXXXXXXXXX" (13 digits, incl.
// country code, no leading "+" or "0") regardless of how it's currently stored.
function normalizeNgPhone(phone) {
  let digits = (phone || '').replace(/\D/g, '');
  if (digits.startsWith('234')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return `234${digits}`;
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

    // Normalize phone numbers and backfill dob in customer_info — MERPI's
    // hotel booking endpoint rejects requests missing/malformed customer_info
    // (see bookHotelRoom), so bring bus/event payloads in line with it.
    if (ticketData.customer_info) {
      if (ticketData.customer_info.phone_number) {
        ticketData.customer_info.phone_number = normalizeNgPhone(ticketData.customer_info.phone_number);
      }
      if (ticketData.customer_info.kin?.phone_number) {
        ticketData.customer_info.kin.phone_number = normalizeNgPhone(ticketData.customer_info.kin.phone_number);
      }
      if (!ticketData.customer_info.dob) {
        const dob = user.ninVerification?.dateOfBirth || user.bvnVerification?.dateOfBirth;
        if (dob) ticketData.customer_info.dob = dob;
      }
    }

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

  const dob = user.ninVerification?.dateOfBirth || user.bvnVerification?.dateOfBirth;
  const customerInfo = {
    name:         user.fullName,
    email:        user.email,
    phone_number: normalizeNgPhone(user.phone),
    ...(dob && { dob }),
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
      tickets: tickets.map((t) => ({ id: t.id, count: t.count })),
      experience_id,
      ...(cinema_location_id != null ? { cinema_location_id: Number(cinema_location_id) } : {}),
      attendance_date: toMerpiDate(attendance_date),
      time_id: Number(time_id),
      customer_info: customerInfo,
    };

    // Try multiple known path variants — MERPI docs show inconsistent casing
    // between singular/plural and path ordering.
    const cinemaBuyPaths = [
      '/v1/merpi/experience/buy/tickets',
      '/v1/merpi/experiences/buy/tickets',
      '/v1/merpi/experience/tickets/buy',
    ];

    let data;
    let lastErr;
    for (const path of cinemaBuyPaths) {
      try {
        console.log('[merpi] cinema_ticket buy payload:', JSON.stringify({ path, ...buyPayload }));
        const res2 = await merpi.post(path, buyPayload);
        data = res2.data;
        console.log('[merpi] cinema_ticket buy response:', JSON.stringify(data));
        break;
      } catch (err) {
        lastErr = err;
        console.error('[merpi] cinema_ticket buy failed for path', path,
          '-> status', err.response?.status, 'body', JSON.stringify(err.response?.data));
        if (!isNotFoundErr(err)) break;
      }
    }

    if (!data) throw lastErr;

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

// ─── HOSPITALITY / HOTELS ──────────────────────────────────────────────────────
// Hotels, apartments, resorts and inns. Single-call booking (no hold/validate phase).

const getHotels = async (req, res) => {
  try {
    const { data } = await merpi.get('/v2/merpi/hotels', { params: req.query });
    res.json({ success: true, data: data.data });
  } catch (err) {
    console.error('[merpi] getHotels:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const getHotelRooms = async (req, res) => {
  try {
    const { data } = await merpi.get(`/v2/merpi/hotels/${req.params.id}/rooms`, { params: req.query });
    res.json({ success: true, data: data.data });
  } catch (err) {
    console.error('[merpi] getHotelRooms:', merpiErrMsg(err));
    res.status(err.response?.status || 502).json({ success: false, message: merpiErrMsg(err) });
  }
};

const bookHotelRoom = async (req, res) => {
  const userId = req.user.id || req.user._id;
  const { room_id, number_of_guests, number_of_rooms, checkin_date, checkout_date, amount, guest_info } = req.body;

  if (!room_id) {
    return res.status(400).json({ success: false, message: 'room_id is required.' });
  }
  if (!number_of_guests || !number_of_rooms) {
    return res.status(400).json({ success: false, message: 'number_of_guests and number_of_rooms are required.' });
  }
  if (!checkin_date || !checkout_date) {
    return res.status(400).json({ success: false, message: 'checkin_date and checkout_date are required.' });
  }
  if (!guest_info || !guest_info.name || !guest_info.email || !guest_info.phone_number || !guest_info.dob) {
    return res.status(400).json({ success: false, message: 'guest_info (name, email, phone_number, dob) is required.' });
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (new Date(`${checkin_date}T00:00:00`) <= today) {
    return res.status(400).json({ success: false, message: 'checkin_date must be in the future.' });
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
    name:         guest_info.name,
    email:        guest_info.email,
    phone_number: normalizeNgPhone(guest_info.phone_number),
    dob:          guest_info.dob,
  };

  const reference = genRef('HOTELBOOKING');
  let txn = null;

  // Phase 1 — deduct wallet + create pending record
  try {
    await deductWalletBalance(user, numAmount);

    txn = await MerpiTransaction.create({
      userId,
      type: 'hotel_booking',
      reference,
      amount: numAmount,
      status: 'pending',
      walletDeducted: true,
    });
  } catch (err) {
    console.error('[merpi] hotel_booking DB phase failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not initiate booking. Please try again.' });
  }

  // Phase 2 — call MERPI. Docs say POST /v2/merpi/hotels/buy, but the example
  // code snippets post to /v2/merpi/hotels/book — try both, in that order.
  const bookingPayload = {
    room_id,
    number_of_guests,
    number_of_rooms,
    checkin_date,
    checkout_date,
    customer_info: customerInfo,
  };

  let data, lastErr;
  for (const path of ['/v2/merpi/hotels/buy', '/v2/merpi/hotels/book']) {
    try {
      console.log('[merpi] hotel_booking payload:', JSON.stringify({ path, ...bookingPayload }));
      const res2 = await merpi.post(path, bookingPayload);
      data = res2.data;
      console.log('[merpi] hotel_booking response:', JSON.stringify(data));
      break;
    } catch (err) {
      lastErr = err;
      console.error('[merpi] hotel_booking failed for path', path,
        '-> status', err.response?.status, 'body', JSON.stringify(err.response?.data));
      if (!isNotFoundErr(err)) break;
    }
  }

  if (!data) {
    await refundWalletBalance(user, numAmount).catch((re) =>
      console.error('[merpi] hotel_booking refund failed:', re.message)
    );
    await MerpiTransaction.findByIdAndUpdate(txn._id, {
      status: 'failed',
      bookingDetails: lastErr.response?.data ?? { error: lastErr.message },
    }).catch(() => {});

    return res.status(lastErr.response?.status || 502).json({
      success: false,
      message: merpiErrMsg(lastErr),
    });
  }

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
  // Hospitality
  getHotels, getHotelRooms, bookHotelRoom,
  // General
  getCategories, getBusinesses, getTransaction,
};
