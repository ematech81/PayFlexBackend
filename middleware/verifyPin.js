const bcrypt = require("bcryptjs");
const User   = require("../models/user");

// transactionPinHash has select:false in the User schema, so protect() never
// loads it. We must fetch it explicitly here rather than reading req.user.
module.exports = async function verifyPin(req, res, next) {
  try {
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({ message: "Transaction PIN is required" });
    }

    const user = await User.findById(req.user.id).select("+transactionPinHash");

    if (!user?.transactionPinHash) {
      return res.status(403).json({ message: "Transaction PIN not set" });
    }

    const isMatch = await bcrypt.compare(String(pin), user.transactionPinHash);

    if (!isMatch) {
      return res.status(403).json({ message: "Invalid Transaction PIN" });
    }

    next();
  } catch (error) {
    next(error);
  }
};
