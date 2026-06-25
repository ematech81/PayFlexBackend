const bcrypt = require('bcryptjs');
const User   = require('../models/user');

const MAX_ATTEMPTS   = 5;
const LOCK_MS        = 15 * 60 * 1000; // 15-minute lockout after 5 wrong PINs

// Per-user in-memory attempt tracker. Resets on server restart (acceptable for
// Railway single-instance; Redis would be needed for multi-instance scale-out).
const _attempts = new Map();

// Purge stale entries every hour so the Map doesn't grow unboundedly.
setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of _attempts) {
    if (!entry.lockedUntil || entry.lockedUntil < now) _attempts.delete(uid);
  }
}, 60 * 60 * 1000);

module.exports = async function verifyPin(req, res, next) {
  const userId = String(req.user.id);
  const now    = Date.now();

  const entry = _attempts.get(userId);
  if (entry?.lockedUntil && entry.lockedUntil > now) {
    const mins = Math.ceil((entry.lockedUntil - now) / 60_000);
    return res.status(429).json({
      success: false,
      message: `Too many wrong PINs. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
    });
  }

  try {
    const { pin } = req.body;
    if (!pin) {
      return res.status(400).json({ success: false, message: 'Transaction PIN is required' });
    }

    const user = await User.findById(userId).select('+transactionPinHash');
    if (!user?.transactionPinHash) {
      return res.status(403).json({ success: false, message: 'Transaction PIN not set' });
    }

    const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);

    if (!isMatch) {
      const current = _attempts.get(userId) || { count: 0 };
      current.count += 1;
      if (current.count >= MAX_ATTEMPTS) {
        current.lockedUntil = now + LOCK_MS;
        current.count       = 0;
        _attempts.set(userId, current);
        return res.status(429).json({
          success: false,
          message: 'Too many wrong PINs. Your account is locked for 15 minutes.',
        });
      }
      _attempts.set(userId, current);
      const left = MAX_ATTEMPTS - current.count;
      return res.status(403).json({
        success: false,
        message: `Invalid Transaction PIN. ${left} attempt${left !== 1 ? 's' : ''} remaining.`,
      });
    }

    // Correct PIN — reset any prior failure count.
    _attempts.delete(userId);
    next();
  } catch (error) {
    next(error);
  }
};
