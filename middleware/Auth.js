// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/user');

/**
 * Protect Middleware
 * Authenticates user via JWT token
 * Adds user object to req.user
 */
const protect = async (req, res, next) => {
  try {
    let token;

    // Check for token in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // Check if token exists
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized. Please log in.',
      });
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Find user by ID from token
      const user = await User.findById(decoded.id).select('-password');

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'User not found. Please log in again.',
        });
      }

      // Check if user is active
      if (user.isActive === false) {
        return res.status(403).json({
          success: false,
          message: 'Your account has been deactivated. Please contact support.',
        });
      }

      // Attach user to request object
      req.user = user;
      
      console.log(`✅ User authenticated: ${user.email}`);
      
      next();
    } catch (error) {
      console.error('❌ Token verification failed:', error.message);
      
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: 'Invalid token. Please log in again.',
        });
      }
      
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired. Please log in again.',
        });
      }

      throw error;
    }
  } catch (error) {
    console.error('❌ Auth middleware error:', error.message);
    
    return res.status(500).json({
      success: false,
      message: 'Authentication error. Please try again.',
    });
  }
};

/**
 * Admin-Only Middleware
 * Restricts access to admin users only
 * Must be used AFTER the 'protect' middleware
 * 
 * Usage:
 * router.get('/admin-route', protect, adminOnly, controllerFunction);
 */
const adminOnly = (req, res, next) => {
  try {
    // Check if user exists (should be set by protect middleware)
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    // Check if user has admin role
    if (req.user.role !== 'admin') {
      console.warn(`⚠️ Non-admin user attempted to access admin route: ${req.user.email}`);
      
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin privileges required.',
      });
    }

    console.log(`✅ Admin access granted: ${req.user.email}`);
    
    // User is admin, proceed to next middleware/controller
    next();
  } catch (error) {
    console.error('❌ Admin middleware error:', error.message);
    
    return res.status(500).json({
      success: false,
      message: 'Error verifying admin status',
    });
  }
};

/**
 * Optional: Super Admin Only Middleware
 * For extremely sensitive operations
 */
const superAdminOnly = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    // Check if user has super admin role
    if (req.user.role !== 'superadmin') {
      console.warn(`⚠️ Non-super-admin user attempted to access super admin route: ${req.user.email}`);
      
      return res.status(403).json({
        success: false,
        message: 'Access denied. Super admin privileges required.',
      });
    }

    console.log(`✅ Super admin access granted: ${req.user.email}`);
    next();
  } catch (error) {
    console.error('❌ Super admin middleware error:', error.message);
    
    return res.status(500).json({
      success: false,
      message: 'Error verifying super admin status',
    });
  }
};

/**
 * Optional: Verified Users Only Middleware
 * For routes that require email verification
 */
const verifiedOnly = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (!req.user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        message: 'Email verification required. Please verify your email.',
      });
    }

    next();
  } catch (error) {
    console.error('❌ Verified middleware error:', error.message);
    
    return res.status(500).json({
      success: false,
      message: 'Error verifying user status',
    });
  }
};


/**
 * Flexible role-based middleware
 * Usage: requireRoles('admin', 'superadmin')
 */
const requireRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
      });
    }

    next();
  };
};

module.exports = {
  protect,
  adminOnly,
  superAdminOnly,
  verifiedOnly,
  requireRoles
};

//     const token = auth.startsWith("Bearer ") ? auth.split(" ")[1] : null;
    
//     if (!token) {
//       return res.status(401).json({ 
//         success: false,
//         message: "No token provided" 
//       });
//     }

//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     const user = await User.findById(decoded.id);
    
//     if (!user) {
//       return res.status(401).json({ 
//         success: false,
//         message: "User not found" 
//       });
//     }

//     req.user = user; // ✅ This attaches the full user object
//     next();
//   } catch (e) {
//     console.error("Auth middleware error:", e.message); // ✅ Add logging
//     return res.status(401).json({ 
//       success: false,
//       message: "Invalid or expired token" 
//     });
//   }
// };

// exports.requireRoles =
//   (...roles) =>
//   (req, res, next) => {
//     if (!req.user) {
//       return res.status(401).json({ 
//         success: false,
//         message: "Unauthorized" 
//       });
//     }
//     const has = req.user.roles.some((r) => roles.includes(r));
//     if (!has) {
//       return res.status(403).json({ 
//         success: false,
//         message: "Forbidden" 
//       });
//     }
//     next();
//   };