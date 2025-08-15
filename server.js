const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");

const connectDB = require("./config/db");
const { apiLimiter } = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");

dotenv.config();
connectDB();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));

// Static for local ID uploads (dev only)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Global rate-limit on auth & kyc endpoints
app.use("/api/auth", apiLimiter);
app.use("/api/kyc", apiLimiter);

// Routes
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/kyc", require("./routes/kycRoutes"));
app.use("/api/pin", require("./routes/pinRoutes"));
app.use("/api/payments", require("./routes/paymentRoutes"));
app.use("/api/phone", require("./routes/phoneVerificationRoutes"));

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// Error handler (last)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
