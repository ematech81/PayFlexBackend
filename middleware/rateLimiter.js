const rateLimit = require('express-rate-limit');

// Strict limiter for auth / KYC — existing behaviour unchanged.
exports.apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

// Moderate global backstop applied to every /api/* route.
// Prevents any single IP hammering the server with concurrent outbound API calls.
exports.globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});
