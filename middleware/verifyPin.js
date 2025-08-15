// middleware/verifyPin.js
const bcrypt = require("bcryptjs");

module.exports = async function verifyPin(req, res, next) {
  try {
    const { pin } = req.body;

    if (!pin) {
      return res.status(400).json({ message: "Transaction PIN is required" });
    }

    if (!req.user?.pinHash) {
      return res.status(403).json({ message: "Transaction PIN not set" });
    }

    const isMatch = await bcrypt.compare(String(pin), req.user.pinHash);

    if (!isMatch) {
      return res.status(403).json({ message: "Invalid Transaction PIN" });
    }

    // If PIN is correct, move to next middleware/controller
    next();
  } catch (error) {
    next(error);
  }
};

// const bcrypt = require("bcryptjs");

// module.exports = async function verifyPin(req, res, next) {
//   try {
//     const { pin } = req.body;
//     if (!pin) return res.status(400).json({ message: "PIN is required" });
//     if (!req.user?.pinHash)
//       return res.status(403).json({ message: "Transaction PIN not set" });

//     const ok = await bcrypt.compare(String(pin), req.user.pinHash);
//     if (!ok) return res.status(403).json({ message: "Invalid PIN" });

//     next();
//   } catch (e) {
//     next(e);
//   }
// };
