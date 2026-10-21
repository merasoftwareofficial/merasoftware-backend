const express = require('express');
const mongoose = require('mongoose');
const authToken = require('../middleware/authToken');
const userModel = require('../models/userModel');
const { Queue, State, STATE_ID, QUEUE_STATUSES } = require('../whatsapp/src/models.js');
const { dayKey } = require('../whatsapp/src/sender.js');
const { loadConfig } = require('../whatsapp/src/config.js');

// The WhatsApp admin page (website /admin/whatsapp, through its /api/whatsapp proxy). Admins only:
// the list holds customers' messages and the QR links the business number.
const router = express.Router();
const PAGE_SIZE = 20;
const WORKER_SILENT_MS = 90_000; // the worker writes a heartbeat every 30 seconds
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(authToken);
router.use(async (req, res, next) => {
  try {
    const user = await userModel.findById(req.userId).select('roles isGuest isActive').lean();
    if (!user || user.isGuest || user.isActive === false || !user.roles?.includes('admin')) return res.status(403).json({ success: false, message: 'Admin access required for WhatsApp' });
    next();
  } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};
const setState = fields => State.updateOne({ _id: STATE_ID }, { $set: fields }, { upsert: true });

router.get('/status', handle(async () => {
  const config = loadConfig();
  const [state, counts] = await Promise.all([
    State.findById(STATE_ID).lean(),
    Queue.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const now = new Date();
  return {
    enabled: process.env.ENABLE_WHATSAPP === 'true',
    workerRunning: !!state?.heartbeatAt && now - state.heartbeatAt < WORKER_SILENT_MS,
    connection: state?.connection || 'disconnected',
    qr: state?.connection === 'qr' ? state.qr || null : null,
    phone: state?.phone || null,
    paused: !!state?.paused,
    unlinkRequested: !!state?.logoutRequested,
    sentToday: state?.day === dayKey(now, config.timeZone) ? state.sentToday : 0,
    dailyLimit: config.dailyLimit,
    nextSendAt: state?.nextSendAt && state.nextSendAt > now ? state.nextSendAt : null,
    lastSentAt: state?.lastSentAt || null,
    lastError: state?.lastError || null,
    messageCap: state?.messageCap || null,
    counts: Object.fromEntries(QUEUE_STATUSES.map(status => [status, counts.find(row => row._id === status)?.count || 0])),
  };
}));

router.get('/queue', handle(async req => {
  const status = String(req.query.status || 'all');
  if (status !== 'all' && !QUEUE_STATUSES.includes(status)) throw new Error('Unknown status');
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const filter = status === 'all' ? {} : { status };
  const retryAfter = new Date(Date.now() - loadConfig().maxAgeMs);
  const [rows, total] = await Promise.all([
    Queue.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
      .select('to email event application text status attempts lastError sentAt createdAt').lean(),
    Queue.countDocuments(filter),
  ]);
  return {
    rows: rows.map(row => ({ ...row, canRetry: row.status === 'failed' && row.createdAt > retryAfter })),
    total, page, pages: Math.ceil(total / PAGE_SIZE),
  };
}));

router.post('/pause', handle(async () => { await setState({ paused: true }); return { paused: true }; }));
router.post('/resume', handle(async () => { await setState({ paused: false }); return { paused: false }; }));
// The worker sees this, unlinks the device and shows a new QR.
router.post('/unlink', handle(async () => { await setState({ logoutRequested: true }); return { unlinkRequested: true }; }));

// Back into the queue: it waits its turn and keeps the 30-second gap like every other message.
router.post('/queue/:id/retry', handle(async req => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new Error('Unknown message');
  const { modifiedCount } = await Queue.updateOne(
    { _id: req.params.id, status: 'failed', createdAt: { $gt: new Date(Date.now() - loadConfig().maxAgeMs) } },
    { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null }, $unset: { expiresAt: 1 } },
  );
  if (!modifiedCount) throw Object.assign(new Error('Only a failed message from the last 24 hours can be sent again.'), { status: 409 });
  return { status: 'pending' };
}));

module.exports = router;
