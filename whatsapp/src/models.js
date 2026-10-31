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
  // Auto Reply's switches. Never inside `settings`: saving the sending rules replaces that whole field.
  autoReply: {
    recognise: { type: Boolean, default: false },
    sendReplies: { type: Boolean, default: false },
    addLeads: { type: Boolean, default: false },
  },
  // Final Message's wait, in hours. Same reason as autoReply for not being inside `settings`.
  finalMessage: {
    hours: Number,
    ignoredReplies: { type: [String], default: undefined }, // unset = the first list (finalMessageReplies.js); empty = nothing is ignored
  },
  lastError: String,
  heartbeatAt: Date,
}, { timestamps: true, collection: 'whatsapp_state', versionKey: false });

const authSchema = new mongoose.Schema({ _id: String, value: { type: String, required: true } },
  { collection: 'whatsapp_auth', versionKey: false });

const lockSchema = new mongoose.Schema({ _id: String, owner: String, expiresAt: Date },
  { collection: 'whatsapp_locks', versionKey: false });

// Auto Reply: the message to recognise. Stored as rows so more could be added later; the screen offers one.
const ruleSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  message: { type: String, required: true, trim: true, maxlength: 1_000 },
  reply: String, // the owner's reply as a saved message document (helpers/broadcastContent.js); empty = the first reply (helpers/autoReplyContent.js)
}, { timestamps: true, collection: 'whatsapp_auto_reply_rules' });

// Auto Reply: one row per recognised message. A message that matches nothing is never saved.
// new → closed by the backend job (helpers/autoReplyJobs.js); needs-attention = its real number wasn't found.
export const INBOX_STATUSES = ['new', 'needs-attention', 'closed'];
export const AUTO_REPLY_EVENT = 'auto-reply'; // the queue row's event, so a waiting reply can be found and cancelled
export const OUR_SIDE_REPLIED = 'Not sent: a message already went to this person from our side.';
const inboxSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true }, // WhatsApp's id: a repeat delivery can't count twice
  ruleId: mongoose.Schema.Types.ObjectId,
  chat: String,
  phone: { type: String, default: null, match: /^[1-9]\d{9,14}$/ }, // digits with country code; null = not found
  text: String,
  profileName: String, // WhatsApp's display name: a hint only, never the person's real name
  deliveredAs: { type: String, enum: ['notify', 'append'] }, // append = came while the worker was offline
  sentAt: Date,
  adMarker: { externalAdReply: Boolean, ctwaClid: Boolean, conversionSource: String },
  status: { type: String, enum: INBOX_STATUSES, default: 'new' },
  outcome: String, // what the job did, in one word (helpers/autoReplyJobs.js)
  // Decided once and kept, so a job that stops halfway can't mistake the lead it just made for an old contact.
  personKnown: Boolean,
  ourSideReplied: Boolean, // a message went to this person from our side before the auto reply's turn
  leadId: mongoose.Schema.Types.ObjectId, // the lead this message created
  matchedLeadId: mongoose.Schema.Types.ObjectId, // the lead that already existed and got this message's remark
  replyText: String, // exactly what was queued, so a retry after a crash uses the same words
  replyStatus: String, // the queue row's status, copied because queue rows expire after 30 days
}, { timestamps: true, collection: 'whatsapp_inbox' });
inboxSchema.index({ status: 1, createdAt: 1 });
inboxSchema.index({ phone: 1, createdAt: 1 });

// Final Message: one row per lead, kept for good so the message never goes twice.
// review → queued → waiting → replied | dead (a late reply: dead → replied). The rest end it:
// not-sent = Don't Send, expired or failed, may be sent again; email-only = no WhatsApp reply to wait for; stopped = the admin moved the lead.
export const FINAL_MESSAGE_STATUSES = ['review', 'queued', 'waiting', 'replied', 'dead', 'not-sent', 'email-only', 'stopped'];
const finalMessageSchema = new mongoose.Schema({
  leadId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  phone: { type: String, default: null, index: true }, // digits with country code; replies from it are noted below
  draftId: mongoose.Schema.Types.ObjectId, // the reviewed message; its queue row has this as emailDraftId
  hours: Number, // the wait this message promised, whatever the setting becomes later
  status: { type: String, enum: FINAL_MESSAGE_STATUSES, default: 'review' },
  sentAt: Date,
  deadlineAt: Date,
  // Written by the worker (inbound.js), acted on by the backend job (helpers/finalMessageJobs.js).
  lastReplyAt: Date,
  lastReplyText: String,
  replySeenAt: Date, // when the job acted on the reply
  // A listed word, an emoji or a reaction: not a reply, the wait goes on. Shown on the lead's timeline only.
  lastIgnoredAt: Date,
  lastIgnoredText: String,
  ignoredNotedAt: Date,
  // The admin's answer to a real reply. Unset = it is in the Needs decision list.
  decision: { type: String, enum: ['interested', 'dead', 'keep'] },
  decidedAt: Date,
  decidedBy: mongoose.Schema.Types.ObjectId,
}, { timestamps: true, collection: 'whatsapp_final_messages' });
finalMessageSchema.index({ status: 1, deadlineAt: 1 });

export const Rule = mongoose.models.WhatsappAutoReplyRule || mongoose.model('WhatsappAutoReplyRule', ruleSchema);
export const FinalMessage = mongoose.models.WhatsappFinalMessage || mongoose.model('WhatsappFinalMessage', finalMessageSchema);
export const Inbox = mongoose.models.WhatsappInbox || mongoose.model('WhatsappInbox', inboxSchema);
export const Queue = mongoose.models.WhatsappQueue || mongoose.model('WhatsappQueue', queueSchema);
export const State = mongoose.models.WhatsappState || mongoose.model('WhatsappState', stateSchema);
export const Auth = mongoose.models.WhatsappAuth || mongoose.model('WhatsappAuth', authSchema);
export const Lock = mongoose.models.WhatsappLock || mongoose.model('WhatsappLock', lockSchema);

export function finishedExpiry(now) {
  return new Date(now.getTime() + KEEP_FINISHED_DAYS * 24 * 60 * 60_000);
}
