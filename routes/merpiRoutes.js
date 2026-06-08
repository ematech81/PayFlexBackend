'use strict';

const express    = require('express');
const router     = express.Router();
const { protect } = require('../middleware/auth');
const verifyPin  = require('../middleware/verifyPin');
const {
  getStates, getCities, getRoutes, getBuses,
  getSchedules, getSeats, buyBusTicket,
  getExperiences, getExperienceDetails, getExperienceTickets, buyExperienceTickets,
  getMovies, getCinemaDetails, getAvailableDates, getCinemaTicketTypes, buyCinemaTickets,
  getCategories, getBusinesses, getTransaction,
} = require('../controllers/merpiController');

// ── Bus Ticketing ─────────────────────────────────────────────────────────────
router.get('/bus/states',         protect, getStates);
router.get('/bus/cities',         protect, getCities);
router.get('/bus/routes',         protect, getRoutes);
router.get('/bus/buses/:schedule_id', protect, getBuses);
router.get('/bus/schedules',      protect, getSchedules);
router.get('/bus/seats',          protect, getSeats);
router.post('/bus/buy',           protect, verifyPin, buyBusTicket);

// ── Events ────────────────────────────────────────────────────────────────────
router.get('/events',             protect, getExperiences);
router.get('/events/:id',         protect, getExperienceDetails);
router.get('/events/:id/tickets', protect, getExperienceTickets);
router.post('/events/buy',        protect, verifyPin, buyExperienceTickets);

// ── Cinema ────────────────────────────────────────────────────────────────────
router.get('/cinema',             protect, getMovies);
router.get('/cinema/:id',         protect, getCinemaDetails);
router.get('/cinema/:id/dates',   protect, getAvailableDates);
router.get('/cinema/:id/tickets', protect, getCinemaTicketTypes);
router.post('/cinema/buy',        protect, verifyPin, buyCinemaTickets);

// ── General ───────────────────────────────────────────────────────────────────
router.get('/categories',              protect, getCategories);
router.get('/businesses',              protect, getBusinesses);
router.get('/transactions/:reference', protect, getTransaction);

module.exports = router;
