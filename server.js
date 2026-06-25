require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const mongoose = require("mongoose");
const vtuAfricaService   = require("./services/vtuAfricaService");
const pricingService     = require("./services/pricingService");
const { runReconciliation }    = require("./util/reconciliationJob");
const { checkBalance }         = require("./util/vtuAfricaMonitor");
const { runMarginSanityCheck } = require("./util/marginSanityCheck");

const connectDB = require("./config/db");
const { apiLimiter, globalLimiter } = require('./middleware/rateLimiter');
const errorHandler = require("./middleware/errorHandler");
const verificationRoutes = require('./routes/verificationRoutes');
const referralRoutes = require('./routes/referralRoutes');
const bookingRoutes = require('./routes/BookingRoutes');
// flightRoutes removed — Amadeus deprecated, Travu replacement pending



const startServer = async () => {
  try {
    // 1️⃣ Validate configs before accepting traffic
    vtuAfricaService.validateStartup();
    pricingService.logStartup();

    // 2️⃣ Connect to MongoDB first
    await connectDB();
    console.log("✅ MongoDB connected successfully");

    // 3️⃣ Initialize Express app
    const app = express();

    // Railway (and most PaaS) sit behind a reverse proxy, so X-Forwarded-For
    // is set on every request. Trust the first hop so express-rate-limit
    // can correctly identify client IPs instead of the proxy's IP.
    app.set('trust proxy', 1);

    // 4️⃣ Apply middlewares
    // The VTU Africa webhook route gets express.raw() BEFORE the global
    // express.json() parser. This preserves the raw Buffer so the webhook
    // controller can verify the MD5 apikey hash against the original bytes.
    // All other routes are unaffected — they still receive parsed JSON.
    // Raw body MUST be applied before express.json() for any webhook path
    // that needs HMAC signature verification on the original bytes.
    app.use('/api/vtu-africa/webhook',  express.raw({ type: '*/*' }));
    app.use('/api/payment/webhook',     express.raw({ type: '*/*' }));
    app.use('/api/webhooks/korapay',    express.raw({ type: '*/*' }));
    app.use('/api/cac/webhook',         express.raw({ type: '*/*' }));

    // Only the specific routes that receive base64 images (~8 MB) get the 25 MB
    // parser. Status-check, validation, and name-reservation routes stay at 2 MB
    // so a single IP cannot exhaust server memory with a crafted large payload.
    app.use('/api/cac/register',      express.json({ limit: '25mb' }));  // BN reg (director images)
    app.use('/api/cac/llc/affiliate', express.json({ limit: '25mb' }));  // LLC affiliate (passport/signature)
    app.use(express.json({ limit: '2mb' }));

    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
      : [];

    app.use(
      cors({
        origin: (origin, callback) => {
          // Allow requests with no origin (mobile apps, curl, Postman)
          if (!origin) return callback(null, true);
          if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
          }
          callback(new Error(`CORS: origin ${origin} not allowed`));
        },
        credentials: true,
      })
    );

    app.use(helmet());
    app.use(morgan("dev"));

    // 5️⃣ Static folder
    app.use("/uploads", express.static(path.join(__dirname, "uploads")));

    // 6️⃣ Rate limiters
    app.use('/api', globalLimiter);   // global backstop: 200 req/min per IP across all routes
    app.use('/api/auth', apiLimiter); // strict: 60 req/min per IP on auth
    app.use('/api/kyc',  apiLimiter); // strict: 60 req/min per IP on KYC


    // 7️⃣ Routes
    app.use("/api/auth", require("./routes/authRoutes"));
    app.use("/api/kyc", require("./routes/kycRoutes"));
    app.use("/api/pin", require("./routes/pinRoutes"));
    app.use("/api/payments", require("./routes/paymentRoutes"));
    app.use('/api/payment', require('./routes/payStackRoutes'));
    // Central Kora Pay router forwards to this path (ROUTE_PFX in the router env)
    app.use('/api/webhooks/korapay', require('./routes/koraWebhookRoute'));
    app.use('/api/verification', verificationRoutes);
    app.use('/api/referral', referralRoutes);
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/invoices', require('./routes/invoiceRoutes'));
    // /api/flights removed — Amadeus deprecated, Travu replacement pending

    // VTU Africa — exam pins, betting wallet funding, inbound webhooks
    app.use('/api/exam-pins',   require('./routes/examPinRoutes'));
    app.use('/api/betting',     require('./routes/bettingRoutes'));
    app.use('/api/vtu-africa',  require('./routes/vtuAfricaRoutes'));

    // CAC VAS — business name registration & validation
    app.use('/api/cac', require('./routes/cacRoutes'));

    // Bank transfers — KoraPay disbursement
    app.use('/api/transfers', require('./routes/transferRoutes'));

    // Bank transfers — VTU Africa (active fallback while KoraPay docs are pending)
    app.use('/api/vtransfers', require('./routes/vtuTransferRoutes'));

    // MERPI / Syticks — bus tickets, events, cinema
    app.use('/api/merpi', require('./routes/merpiRoutes'));

    // Admin
    app.use('/api/admin/revenue', require('./routes/revenueRoutes'));
    app.use('/api/admin',         require('./routes/adminRoutes'));

    // Subscriptions
    app.use('/api/subscriptions', require('./routes/subscriptionRoutes'));

    // 8️⃣ Health endpoint
    app.get("/health", (req, res) => res.json({ ok: true }));

    // 9️⃣ Global error handler (must be last)
    app.use(errorHandler);

    // 🔟 Background jobs
    // Reconciliation: every 30 minutes — resolves pending VTU Africa transactions
    setInterval(() => runReconciliation().catch(err =>
      console.error('[reconciliation] Unhandled error:', err.message)
    ), 30 * 60 * 1000);

    // Balance monitor: every hour — alerts ops when VTU Africa balance is low
    setInterval(() => checkBalance().catch(err =>
      console.error('[vtuAfricaMonitor] Unhandled error:', err.message)
    ), 60 * 60 * 1000);

    // Margin sanity check: once per day at ~midnight
    setInterval(() => runMarginSanityCheck().catch(err =>
      console.error('[marginSanity] Unhandled error:', err.message)
    ), 24 * 60 * 60 * 1000);

    // 1️⃣1️⃣ Start server
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () =>
      console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`)
    );
  } catch (err) {
    // 🧰 SAFER: handle undefined or non-Error cases
    console.error("❌ Failed to start server:", err?.message || err);
    if (err?.stack) console.error(err.stack);
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
