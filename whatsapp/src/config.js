// Every setting comes from the environment (Render → Environment). Defaults are the owner's rules.
const MIN_GAP_FLOOR_MS = 30_000; // Owner rule: no message ever leaves sooner than 30 seconds after the last one.

function whole(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be a whole number of at least ${min}`);
  return value;
}

export function loadConfig() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is missing in environment variables');
  return {
    mongoUri,
    port: whole('PORT', 8080, 1),
    // Default OFF, like the portal backend's ENABLE_CRONS: a local run against a shared database must never send.
    senderEnabled: process.env.ENABLE_SENDER === 'true',
    // Inside the portal backend (helpers/whatsappWorkerService.js) the backend owns PORT, so no health server.
    embedded: process.env.WHATSAPP_EMBEDDED === 'true',
    minGapMs: whole('MIN_GAP_MS', MIN_GAP_FLOOR_MS, MIN_GAP_FLOOR_MS),
    jitterMs: whole('JITTER_MS', 15_000, 0),
    dailyLimit: whole('DAILY_LIMIT', 150, 1),
    maxAttempts: whole('MAX_ATTEMPTS', 3, 1),
    retryDelayMs: whole('RETRY_DELAY_MS', 5 * 60_000, 60_000),
    // Owner rule: a message still waiting after a day (e.g. number unlinked) is dropped, never sent late.
    maxAgeMs: whole('MAX_AGE_MS', 24 * 60 * 60_000, 60_000),
    timeZone: 'Asia/Kolkata',
    logLevel: process.env.LOG_LEVEL || 'warn',
  };
}
