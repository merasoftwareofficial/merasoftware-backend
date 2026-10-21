// Settings that come from the environment (Render → Environment). The sending rules (gap, daily limit,
// quiet hours, …) are not here: the admin changes them on the WhatsApp page, see settings.js.
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
    timeZone: 'Asia/Kolkata',
    logLevel: process.env.LOG_LEVEL || 'warn',
  };
}
