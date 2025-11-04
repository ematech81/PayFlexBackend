require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const mongoose = require("mongoose");

const connectDB = require("./config/db");
const { apiLimiter } = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");

const startServer = async () => {
  try {
    // 1️⃣ Connect to MongoDB first
    await connectDB();
    console.log("✅ MongoDB connected successfully");

    // 2️⃣ Initialize Express app
    const app = express();

    // 3️⃣ Apply middlewares
    app.use(express.json({ limit: "2mb" }));
    app.use(cors());
    app.use(helmet());
    app.use(morgan("dev"));

    // 4️⃣ Static folder
    app.use("/uploads", express.static(path.join(__dirname, "uploads")));

    // 5️⃣ Rate limiters
    app.use("/api/auth", apiLimiter);
    app.use("/api/kyc", apiLimiter);


    // 6️⃣ Routes
    app.use("/api/auth", require("./routes/authRoutes"));
    app.use("/api/kyc", require("./routes/kycRoutes"));
    app.use("/api/pin", require("./routes/pinRoutes"));
    app.use("/api/payments", require("./routes/paymentRoutes"));
    app.use("/api/phone", require("./routes/phoneVerificationRoutes"));

    // 7️⃣ Health endpoint
    app.get("/health", (req, res) => res.json({ ok: true }));

    // 8️⃣ Global error handler (must be last)
    app.use(errorHandler);

    // 9️⃣ Start server
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () =>
      console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`)
    );
  } catch (err) {
    // 🧰 SAFER: handle undefined or non-Error cases
    console.error("❌ Failed to start server:", err?.message || err);
    process.exit(1);
  }
};

// 🔌 Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await mongoose.connection.close();
  process.exit(0);
});

// 🏁 Start the app
startServer();
