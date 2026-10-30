import mongoose from 'mongoose';

// These collections are the only contract between the WhatsApp worker and the rest of the backend.
// The backend adds rows to whatsapp_queue (helpers/whatsappQueue.js requires this file, so there is
// one schema) and sets paused / logoutRequested on whatsapp_state; the worker does everything else.
export const STATE_ID = 'main';
export const KEEP_FINISHED_DAYS = 30;
export const SLOT_MS = 60_000; // the sending slot lapses this long after its holder last renewed it

export const QUEUE_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped', 'expired', 'cancelled'];

const queueSchema = new mongoose.Schema({
  // Country code + number, digits only. A skipped row (no usable phone) has none.
  to: { type: String, match: /^[1-9]\d{9,14}$/, required() { return this.status !== 'skipped'; } },
  text: { type: String, required: true, maxlength: 60_000 },
  event: String, // email action key, e.g. sendProjectCreatedEmail
  application: { type: String, enum: ['website', 'portal'] },
  emailDraftId: mongoose.Schema.Types.ObjectId, // the sent email this WhatsApp copies
  broadcastRecipientId: mongoose.Schema.Types.ObjectId,
  email: { type: String, lowercase: true, trim: true }, // that email's recipient; one row per recipient
  // pending → sending → sent | failed; skipped = no usable phone; expired = waited more than a day.
  status: { type: String, enum: QUEUE_STATUSES, default: 'pending' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lastError: String,
  messageId: String,
  sentAt: Date,
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } }, // set when finished; Mongo deletes the row then
}, { timestamps: true, collection: 'whatsapp_queue' });
queueSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
queueSchema.index({ broadcastRecipientId: 1 }, { unique: true, partialFilterExpression: { broadcastRecipientId: { $type: 'objectId' } } });
// An email retried or reviewed twice still gives each recipient one WhatsApp.
queueSchema.index({ emailDraftId: 1, email: 1 }, { unique: true, partialFilterExpression: { emailDraftId: { $exists: true } } });

const stateSchema = new mongoose.Schema({
  _id: String,
  connection: { type: String, enum: ['disconnected', 'connecting', 'qr', 'connected', 'logged-out'], default: 'disconnected' },
  qr: String, // data: URL image, only while waiting for a scan
  qrAt: Date,
  phone: String, // linked WhatsApp account
  paused: { type: Boolean, default: false },
  logoutRequested: { type: Boolean, default: false },
  day: String, // YYYY-MM-DD in India time; sentToday belongs to this day (a count to show, not a limit)
  sentToday: { type: Number, default: 0 },
  lastSentAt: Date,
  nextSendAt: Date, // persisted so a restart still waits out the gap
  // The one sending slot (sender.js): only its holder talks to a chat. Taken in the same write that
  // checks the gap, renewed while the message is out, and it lapses SLOT_MS after its holder stops renewing.
  sendingBy: String,
  sendingUntil: Date,
  messageCap: mongoose.Schema.Types.Mixed, // WhatsApp's new-chat quota, as WhatsApp reports it
  settings: mongoose.Schema.Types.Mixed, // the admin's sending rules; checked by settings.js before saving
  lastError: String,
  heartbeatAt: Date,
}, { timestamps: true, collection: 'whatsapp_state', versionKey: false });

const authSchema = new mongoose.Schema({ _id: String, value: { type: String, required: true } },
  { collection: 'whatsapp_auth', versionKey: false });

const lockSchema = new mongoose.Schema({ _id: String, owner: String, expiresAt: Date },
  { collection: 'whatsapp_locks', versionKey: false });

export const Queue = mongoose.models.WhatsappQueue || mongoose.model('WhatsappQueue', queueSchema);
export const State = mongoose.models.WhatsappState || mongoose.model('WhatsappState', stateSchema);
export const Auth = mongoose.models.WhatsappAuth || mongoose.model('WhatsappAuth', authSchema);
export const Lock = mongoose.models.WhatsappLock || mongoose.model('WhatsappLock', lockSchema);

export function finishedExpiry(now) {
  return new Date(now.getTime() + KEEP_FINISHED_DAYS * 24 * 60 * 60_000);
}
