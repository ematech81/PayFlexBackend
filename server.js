require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const connectDB = require("./config/db");
const { apiLimiter } = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");
const mongoose = require("mongoose");

// console.log("Mongo URI:", process.env.MONGO_URI);

const startServer = async () => {
  try {
    await connectDB(); //  Wait for MongoDB to connect first
    const app = express();

    app.use(express.json({ limit: "2mb" }));
    app.use(cors());
    app.use(helmet());
    app.use(morgan("dev"));

    // Static folder
    app.use("/uploads", express.static(path.join(__dirname, "uploads")));

    // Rate limiters
    app.use("/api/auth", apiLimiter);
    app.use("/api/kyc", apiLimiter);

    // Routes
    app.use("/api/auth", require("./routes/authRoutes"));
    app.use("/api/kyc", require("./routes/kycRoutes"));
    app.use("/api/pin", require("./routes/pinRoutes"));
    app.use("/api/payments", require("./routes/paymentRoutes"));
    app.use("/api/phone", require("./routes/phoneVerificationRoutes"));

    // Health endpoint
    app.get("/health", (req, res) => res.json({ ok: true }));

    // Global error handler
    app.use(errorHandler);

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
};

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
