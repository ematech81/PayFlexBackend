const rateLimit = require("express-rate-limit");

exports.apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60, // 60 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});
