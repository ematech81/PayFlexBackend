const bcrypt = require("bcryptjs");

module.exports = async function verifyPin(req, res, next) {
  try {
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({ message: "Transaction PIN is required" });
    }

    if (!req.user?.transactionPinHash) {
      return res.status(403).json({ message: "Transaction PIN not set" });
    }

    const isMatch = await bcrypt.compare(
      String(pin),
      req.user.transactionPinHash
    );

    if (!isMatch) {
      return res.status(403).json({ message: "Invalid Transaction PIN" });
    }

    // If PIN is correct, move to next middleware/controller
    next();
  } catch (error) {
    next(error);
  }
};
