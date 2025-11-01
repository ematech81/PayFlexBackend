
const jwt = require("jsonwebtoken");
const User = require("../models/user");

exports.protect = async (req, res, next) => {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.split(" ")[1] : null;
    
    if (!token) {
      return res.status(401).json({ 
        success: false,
        message: "No token provided" 
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user) {
      return res.status(401).json({ 
        success: false,
        message: "User not found" 
      });
    }

    req.user = user; // ✅ This attaches the full user object
    next();
  } catch (e) {
    console.error("Auth middleware error:", e.message); // ✅ Add logging
    return res.status(401).json({ 
      success: false,
      message: "Invalid or expired token" 
    });
  }
};

exports.requireRoles =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: "Unauthorized" 
      });
    }
    const has = req.user.roles.some((r) => roles.includes(r));
    if (!has) {
      return res.status(403).json({ 
        success: false,
        message: "Forbidden" 
      });
    }
    next();
  };