const express = require('express');
const communicationAdmin = require('../middleware/communicationAdmin');
const { FinalMessage, Inbox, Rule, State, STATE_ID } = require('../whatsapp/src/models.js');
const Lead = require('../models/leadModel');
const { NEGATIVE } = require('../helpers/leadStatuses');
const { MAX_HOURS, MIN_HOURS, decideReply, readHours, readIgnored, saveIgnored } = require('../helpers/finalMessage');
const { DEFAULT_AD_MESSAGE, MIN_AD_MESSAGE, RULE_KEY, cleanText } = require('../whatsapp/src/autoReplyRules.js');
const { workerAlive } = require('../helpers/whatsappReadiness');
const { encodeReply, replyDoc } = require('../helpers/autoReplyContent');
const { cancelWaitingReplies } = require('../helpers/autoReplyJobs');

// The Auto Reply box (website Communication, through its /api/auto-reply proxy). Admins only: it holds people's messages.
const router = express.Router();
const RECENT_ROWS = 20;
const SWITCHES = ['recognise', 'sendReplies', 'addLeads'];
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(communicationAdmin);
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const ensureRule = () => Rule.findOneAndUpdate({ key: RULE_KEY }, { $setOnInsert: { key: RULE_KEY, message: DEFAULT_AD_MESSAGE } },
  { upsert: true, new: true }).lean();

router.get('/status', handle(async () => {
  const [state, rule, rows, total, needsAttention, repliesSent, repliesWaiting, newLeads] = await Promise.all([
    State.findById(STATE_ID).lean(),
    ensureRule(),
    Inbox.find().sort({ createdAt: -1 }).limit(RECENT_ROWS)
      .select('phone text profileName deliveredAs sentAt adMarker status outcome replyStatus createdAt').lean(),
    Inbox.countDocuments(),
    Inbox.countDocuments({ status: 'needs-attention' }),
    Inbox.countDocuments({ replyStatus: 'sent' }),
    Inbox.countDocuments({ replyStatus: { $in: ['pending', 'sending'] } }),
    Inbox.countDocuments({ leadId: { $exists: true } }),
  ]);
  return {
    switches: Object.fromEntries(SWITCHES.map(key => [key, !!state?.autoReply?.[key]])),
    // Recognising needs the worker running and the number linked, whatever the switch says.
    listening: process.env.ENABLE_WHATSAPP === 'true' && workerAlive(state, new Date()) && state?.connection === 'connected',
    message: rule.message,
    minMessage: MIN_AD_MESSAGE,
    reply: replyDoc(rule),
    detected: { rows, total, needsAttention, repliesSent, repliesWaiting, newLeads },
  };
}));

router.post('/switches', handle(async req => {
  const changes = Object.entries(req.body || {});
  if (!changes.length || changes.some(([key, value]) => !SWITCHES.includes(key) || typeof value !== 'boolean')) fail('Choose On or Off.');
  await State.updateOne({ _id: STATE_ID }, { $set: Object.fromEntries(changes.map(([key, value]) => [`autoReply.${key}`, value])) }, { upsert: true });
  // Off means no auto reply goes out from now on, including those still waiting in the queue.
  const stopsReplies = changes.some(([key, value]) => ['recognise', 'sendReplies'].includes(key) && value === false);
  return { cancelled: stopsReplies ? await cancelWaitingReplies() : 0 };
}));

router.post('/message', handle(async req => {
  const message = String(req.body?.message || '').trim();
  if (cleanText(message).length < MIN_AD_MESSAGE) fail(`Write the ad's full message, at least ${MIN_AD_MESSAGE} letters. Short messages would match ordinary chats.`);
  if (message.length > 1_000) fail('This message is too long.');
  await ensureRule();
  await Rule.updateOne({ key: RULE_KEY }, { $set: { message } });
  return { message };
}));

// A reply already waiting in the queue keeps its words; this applies to the next person.
router.post('/reply', handle(async req => {
  const reply = encodeReply(req.body?.doc);
  await ensureRule();
  await Rule.updateOne({ key: RULE_KEY }, { $set: { reply } });
  return { saved: true };
}));

// The Final Message box. Only the wait and the results live here: the message is an Email Templates action and is sent from the portal's popup.
router.get('/final-message', handle(async () => {
  const [hours, ignoredReplies, counts, replied] = await Promise.all([
    readHours(),
    readIgnored(),
    FinalMessage.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    FinalMessage.find({ status: 'replied', decision: null }).sort({ replySeenAt: -1 }).select('leadId phone lastReplyAt lastReplyText').lean(),
  ]);
  const leads = await Lead.find({ _id: { $in: replied.map(row => row.leadId) }, deletedAt: null }).select('name status').lean();
  return {
    hours, minHours: MIN_HOURS, maxHours: MAX_HOURS, ignoredReplies,
    counts: Object.fromEntries(counts.map(row => [row._id, row.count])),
    // A lead the admin has already moved by hand needs no decision here.
    needsDecision: replied.flatMap(row => {
      const lead = leads.find(item => String(item._id) === String(row.leadId));
      return lead?.status === NEGATIVE ? [{ ...row, name: lead.name || '' }] : [];
    }),
  };
}));

router.post('/final-message/ignored', handle(async req => ({ ignoredReplies: await saveIgnored(req.body?.ignoredReplies) })));

router.post('/final-message/decision', handle(req => decideReply(req.body?.id, req.body?.choice, req.userId)));

// Applies to messages prepared from now on. A message already out keeps the wait it promised.
router.post('/final-message/time', handle(async req => {
  const hours = Number(req.body?.hours);
  if (!Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) fail(`Choose a whole number of hours, from ${MIN_HOURS} to ${MAX_HOURS}.`);
  await State.updateOne({ _id: STATE_ID }, { $set: { 'finalMessage.hours': hours } }, { upsert: true });
  return { hours };
}));

module.exports = router;
