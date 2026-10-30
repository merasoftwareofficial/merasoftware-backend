const express = require('express');
const mongoose = require('mongoose');
const communicationAdmin = require('../middleware/communicationAdmin');
const { Queue, State, STATE_ID, QUEUE_STATUSES } = require('../whatsapp/src/models.js');
const { dayKey } = require('../whatsapp/src/sender.js');
const { loadConfig } = require('../whatsapp/src/config.js');
const { RECOMMENDED, LIMITS, effectiveSettings, inQuietHours, quietEnd, settingsWarnings, validateSettings } = require('../whatsapp/src/settings.js');
const { estimateQueue } = require('../whatsapp/src/schedule.js');

// The WhatsApp admin page (website /admin/whatsapp, through its /api/whatsapp proxy). Admins only:
// the list holds customers' messages and the QR links the business number.
const router = express.Router();
const PAGE_SIZE = 20;
const { workerAlive, stoppedReason } = require('../helpers/whatsappReadiness');
const UPCOMING_MAX = 500; // the queue page shows this many waiting messages at most (100 a day is the expected load)
const WAITING = ['pending', 'sending'];
const NOT_SENT = ['failed', 'skipped', 'expired', 'cancelled'];
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(communicationAdmin);
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};
const setState = fields => State.updateOne({ _id: STATE_ID }, { $set: fields }, { upsert: true });
const savedSettings = async () => effectiveSettings((await State.findById(STATE_ID).select('settings').lean())?.settings);
const maxAgeMs = settings => settings.maxAgeHours * 3_600_000;
const settingsReply = settings => ({ settings, recommended: RECOMMENDED, limits: LIMITS, warnings: settingsWarnings(settings) });

router.get('/status', handle(async () => {
  const config = loadConfig();
  const [state, counts] = await Promise.all([
    State.findById(STATE_ID).lean(),
    Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const now = new Date();
  const settings = effectiveSettings(state?.settings);
  return {
    enabled: process.env.ENABLE_WHATSAPP === 'true',
    workerRunning: workerAlive(state, now),
    connection: state?.connection || 'disconnected',
    qr: state?.connection === 'qr' ? state.qr || null : null,
    phone: state?.phone || null,
    paused: !!state?.paused,
    unlinkRequested: !!state?.logoutRequested,
    sentToday: state?.day === dayKey(now, config.timeZone) ? state.sentToday : 0,
    minGapSec: settings.minGapSec,
    maxAgeHours: settings.maxAgeHours,
    quietNow: inQuietHours(settings, now, config.timeZone),
    quietTo: settings.quietTo,
    nextSendAt: state?.nextSendAt && state.nextSendAt > now ? state.nextSendAt : null,
    lastSentAt: state?.lastSentAt || null,
    lastError: state?.lastError || null,
    messageCap: state?.messageCap || null,
    counts: Object.fromEntries(QUEUE_STATUSES.map(status => [status, counts.find(row => row._id === status)?.count || 0])),
  };
}));

router.get('/queue', handle(async req => {
  // 'not-sent' = every finished message that did not go: failed, skipped and expired together.
  const status = String(req.query.status || 'all');
  if (status !== 'all' && status !== 'not-sent' && !QUEUE_STATUSES.includes(status)) throw new Error('Unknown status');
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const filter = status === 'all' ? {} : status === 'not-sent' ? { status: { $in: NOT_SENT } } : { status };
  const retryAfter = new Date(Date.now() - maxAgeMs(await savedSettings()));
  const [rows, total] = await Promise.all([
    Queue.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
      .select('to email event application text status attempts lastError sentAt createdAt broadcastRecipientId').lean(),
    Queue.countDocuments(filter),
  ]);
  return {
    rows: rows.map(row => ({ ...row, canRetry: !row.broadcastRecipientId && row.status === 'failed' && row.createdAt > retryAfter })),
    total, page, pages: Math.ceil(total / PAGE_SIZE),
  };
}));

// The waiting messages in the order they will go, each with when it should leave (schedule.js).
// `stopped` says why nothing is leaving (no times then); `quietUntil` is set during quiet hours.
router.get('/queue/upcoming', handle(async () => {
  const config = loadConfig();
  const [state, rows, total] = await Promise.all([
    State.findById(STATE_ID).lean(),
    Queue.find({ status: { $in: WAITING } }).sort({ createdAt: 1 }).limit(UPCOMING_MAX)
      .select('to email event application text status attempts lastError createdAt nextAttemptAt').lean(),
    Queue.countDocuments({ status: { $in: WAITING } }),
  ]);
  const now = new Date();
  const rules = effectiveSettings(state?.settings);
  const stopped = stoppedReason(state, now);
  const estimated = estimateQueue({ rows, nextSendAt: state?.nextSendAt, rules, now, timeZone: config.timeZone, stopped: !!stopped });
  return {
    rows: estimated.map((row, index) => ({ ...row, position: index + 1 })),
    total, stopped, now,
    quietUntil: inQuietHours(rules, now, config.timeZone) ? quietEnd(rules, now, config.timeZone) : null,
    sentToday: state?.day === dayKey(now, config.timeZone) ? state.sentToday : 0,
  };
}));

router.post('/pause', handle(async () => { await setState({ paused: true }); return { paused: true }; }));
router.post('/resume', handle(async () => { await setState({ paused: false }); return { paused: false }; }));
// The worker sees this, unlinks the device and shows a new QR.
router.post('/unlink', handle(async () => { await setState({ logoutRequested: true }); return { unlinkRequested: true }; }));

// Back into the queue: it waits its turn and keeps the gap like every other message.
router.post('/queue/:id/retry', handle(async req => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new Error('Unknown message');
  const settings = await savedSettings();
  const { modifiedCount } = await Queue.updateOne(
    { _id: req.params.id, broadcastRecipientId: { $exists: false }, status: 'failed', createdAt: { $gt: new Date(Date.now() - maxAgeMs(settings)) } },
    { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null }, $unset: { expiresAt: 1 } },
  );
  if (!modifiedCount) throw Object.assign(new Error(`Only a failed message from the last ${settings.maxAgeHours} hours can be sent again.`), { status: 409 });
  return { status: 'pending' };
}));

// Sending rules (ban safety). The worker reads them before every message, so a save applies at once.
router.get('/settings', handle(async () => settingsReply(await savedSettings())));
router.post('/settings', handle(async req => {
  const settings = validateSettings(req.body);
  await setState({ settings });
  return settingsReply(settings);
}));
router.post('/settings/reset', handle(async () => {
  await setState({ settings: { ...RECOMMENDED } });
  return settingsReply({ ...RECOMMENDED });
}));

module.exports = router;
