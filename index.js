const express = require('express')
const http = require('http')
const cors = require('cors')
const cookieParser = require('cookie-parser')
require('dotenv').config()
require('./helpers/sessionToken').sessionSecret()
const connnectDB = require("./config/db")
const router = require("./routes")
const fileCleanupScheduler = require('./helpers/fileCleanupScheduler');
const { scheduleServicePlanRenewals } = require('./cron/servicePlanRenewalCron');
const cron = require("node-cron");
const axios = require("axios");
const { initChessSocket } = require('./chess/chessSocket');
const { scheduleChessCleanup } = require('./chess/chessCleanupCron');
const { getAllowedOrigins } = require('./config/allowedOrigins');


const app = express()
const server = http.createServer(app)

// These crons write and delete real data (renewals charge wallets, file cleanup
// deletes Drive files). They must run only where that is intended — production —
// not on a developer's machine or a clone/staging run against a shared database.
// Default OFF: a missing or unset ENABLE_CRONS never starts them by accident.
// Render production sets ENABLE_CRONS=true in its own environment variables.
const cronsEnabled = process.env.ENABLE_CRONS === 'true';
if (cronsEnabled) {
  fileCleanupScheduler.scheduleCleanup();
  scheduleServicePlanRenewals();
  require('./cron/offerPaymentReminderCron').scheduleOfferPaymentReminders();
  scheduleChessCleanup();
  console.log('File cleanup scheduler initialized');
  console.log('Service-plan renewal scheduler initialized');
} else {
  console.log('Crons disabled (ENABLE_CRONS is not "true") — skipping cleanup/renewal/chess-cleanup schedulers.');
}
// Reservation jobs have their own switch (owner decision 12): enabling them never starts the
// wallet-charging renewal crons above. Each job also checks its own feature flag.
if (process.env.OFFER_RESERVATION_JOBS_ENABLED === 'true') {
  cron.schedule('* * * * *', async () => {
    await require('./helpers/offerReservationConfirmation').drainReservationConfirmations().catch(error => console.error('[reservation confirmation]', error.message));
    await require('./helpers/reservationRepricing').reconcileDueReservations().catch(error => console.error('[reservation repricing]', error.message));
  });
  console.log('Offer reservation jobs initialized');
}

const allowedOrigins = getAllowedOrigins();

initChessSocket(server, allowedOrigins);

// Single source of truth for CORS so the actual-request handler and the
// preflight (OPTIONS) handler always advertise the same origins, methods,
// and headers. Any drift between the two causes browsers to reject requests
// (e.g. a missing PATCH in Access-Control-Allow-Methods).
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    const normalisedOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(normalisedOrigin)) {
      return callback(null, true);
    }

    console.log('Origin not allowed by CORS:', origin);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"],
  exposedHeaders: ['X-Upload-Timing-Id']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));


app.use(require('./helpers/uploadTiming').uploadTimingMiddleware)
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ limit: '10mb', extended: true }))
app.use(cookieParser())

app.use("/api", require("./helpers/emailController").requestMiddleware)
app.use("/api/email-control", require("./routes/emailControl"))
app.use("/api/whatsapp-control", require("./routes/whatsappControl"))
app.use("/api", router)

app.use('/uploads', express.static('uploads'));

app.head('/ping', (req, res) => {
  console.log('HEAD Ping received at:', new Date().toISOString());
  res.status(200).end(); // No body, only headers
});


const PORT = process.env.PORT || 8080;
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;

// Keep-alive only matters for a real deployment that can go idle (e.g. Render free
// tier). It does not write any data, but there is no reason to run it locally.
if (cronsEnabled) {
  cron.schedule("*/5 * * * *", async () => {
    try {
      if (KEEP_ALIVE_URL) {
        await axios.head(KEEP_ALIVE_URL);
        console.log(` ✅ Keep-alive request sent to ${KEEP_ALIVE_URL}`);
      } else {
        console.warn("⚠️ KEEP_ALIVE_URL is not set in .env file");
      }
    } catch (error) {
      console.error("❌ Keep-alive request failed:", error.message);
    }
  });
}

async function startServer() {
  try {
    await connnectDB();
    console.log("Connected to DB");
    require('./helpers/portfolioWorkerService').startPortfolioWorkerService();
    require('./helpers/whatsappWorkerService').startWhatsappWorkerService();
    require('./helpers/uploadWorker').startUploadWorker();
    server.listen(PORT, () => {
      console.log("Server is running " + PORT);
    });
  } catch (error) {
    console.error("Failed to connect to DB:", error.message);
    process.exit(1);
  }
}

startServer();
