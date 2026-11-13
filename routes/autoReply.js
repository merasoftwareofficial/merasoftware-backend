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
  catch (error) { res.status(error.status || error.statusCode || 400).json({ success: false, message: error.message }); }
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
  const cameBack = { $cond: [{ $ifNull: ['$$this.cameBackAt', false] }, 1, 0] };
  const [hours, ignoredReplies, counts, [cameBackTotal], replied] = await Promise.all([
    readHours(),
    readIgnored(),
    FinalMessage.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    // Everyone who wrote after a closure message and came back (helpers/finalMessageComeback.js), earlier cycles included.
    FinalMessage.aggregate([{ $project: { n: { $reduce: { input: { $concatArrays: [[{ cameBackAt: '$cameBackAt' }], { $ifNull: ['$episodeHistory', []] }] }, initialValue: 0, in: { $add: ['$$value', cameBack] } } } } },
      { $group: { _id: null, count: { $sum: '$n' } } }]),
    FinalMessage.find({ status: 'replied', decision: null }).sort({ replySeenAt: -1 }).select('leadId phone lastReplyAt lastReplyText subjectKind clientId behaviourRevision').lean(),
  ]);
  const leads = await Lead.find({ _id: { $in: replied.map(row => row.leadId) }, deletedAt: null }).select('name status clientBehaviour clientBehaviourRevision convertedToUserId').lean();
  return {
    hours, minHours: MIN_HOURS, maxHours: MAX_HOURS, ignoredReplies,
    counts: { ...Object.fromEntries(counts.map(row => [row._id, row.count])), 'came-back': cameBackTotal?.count || 0 },
    // A lead the admin has already moved by hand needs no decision here.
    needsDecision: replied.flatMap(row => {
      const lead = leads.find(item => String(item._id) === String(row.leadId));
      const validClient = row.subjectKind === 'client' && lead?.status === 'Won' && lead.clientBehaviour === NEGATIVE && String(lead.convertedToUserId) === String(row.clientId) && (lead.clientBehaviourRevision || 0) === (row.behaviourRevision || 0);
      return (validClient || (row.subjectKind !== 'client' && lead?.status === NEGATIVE)) ? [{ ...row, name: lead.name || '' }] : [];
    }),
  };
}));

router.post('/final-message/ignored', handle(async req => ({ ignoredReplies: await saveIgnored(req.body?.ignoredReplies) })));

router.post('/final-message/decision', handle(req => decideReply(req.body?.id, req.body?.choice, req.userId)));

// The Reservation box: counts and the running reservations. The hours live on each offer and the
// three messages are Email Templates actions, so this box only shows how reservations stand.
router.get('/reservations', handle(() => require('../helpers/reservationClosure').reservationOverview()));
router.get('/reservations/:id/paid-projects', handle(req => require('../helpers/reservationPaidReconcile').candidates(req.params.id)));
router.post('/reservations/:id/reconcile-paid-project', handle(req => require('../helpers/reservationPaidReconcile').reconcile({ reservationId: req.params.id, orderId: req.body?.orderId, actorId: req.userId, confirmSlug: req.body?.confirmSlug, reason: req.body?.reason, acknowledgeMismatch: req.body?.acknowledgeMismatch })));
router.post('/reminder-controls', handle(req => {
  if (typeof req.body?.expectedPaused !== 'boolean') fail('Refresh the reminder state before changing it.');
  return require('../helpers/legacyReminderControls').setPaused({ source: req.body?.source, entityId: req.body?.entityId,
    paused: req.body?.paused, expectedPaused: req.body.expectedPaused, actorId: req.userId });
}));
// Compatibility for already-open clients; both routes use the same owner-level operation.
router.post('/reservations/:id/reminders', handle(req => require('../helpers/legacyReminderControls').setPaused({ source: 'reservation', entityId: req.params.id,
  paused: req.body?.paused, expectedPaused: req.body?.expectedPaused, actorId: req.userId })));
router.post('/package-starts/:id/close', handle(req => require('../helpers/packageStart').closeByTeam({ requestId: req.params.id, actorId: req.userId })));
router.get('/payment-reminders', handle(req => require('../helpers/offerReminderOverview').offerReminderOverview({ page: req.query.page, view: req.query.view })));
router.get('/legacy-reminder-history', handle(req => require('../helpers/legacyReminderHistory').legacyReminderHistory({ source: req.query.source, entityId: req.query.entityId, page: req.query.page })));
router.get('/business-activity', handle(() => require('../helpers/communicationActivity').recentActivity()));
router.get('/reminder-work-summary', handle(() => require('../helpers/reminderWorkSummary').workSummary()));
router.get('/reminder-rules', handle(() => require('../helpers/communicationReminderRules').listDrafts()));
router.get('/reminder-runs', handle(req => require('../helpers/communicationReminderHistory').reminderHistory({ page: req.query.page, view: req.query.view, source: req.query.source })));
router.post('/reminder-runs/:id/retry', handle(req => require('../helpers/communicationReminderRetry').retryQueueFailure(req.params.id)));
router.post('/reminder-rules', handle(req => require('../helpers/communicationReminderRules').createDraft(req.body, req.userId)));
router.put('/reminder-rules/:id', handle(req => require('../helpers/communicationReminderRules').updateDraft(req.params.id, req.body)));
router.post('/reminder-rules/:id/enabled', handle(req => require('../helpers/communicationReminderRules').setEnabled(req.params.id, req.body?.enabled, req.body?.expectedRevision)));
router.get('/reminder-rules/:id/preview', handle(req => require('../helpers/communicationReminderPreview').previewRule(req.params.id)));

// Applies to messages prepared from now on. A message already out keeps the wait it promised.
router.post('/final-message/time', handle(async req => {
  const hours = Number(req.body?.hours);
  if (!Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) fail(`Choose a whole number of hours, from ${MIN_HOURS} to ${MAX_HOURS}.`);
  await State.updateOne({ _id: STATE_ID }, { $set: { 'finalMessage.hours': hours } }, { upsert: true });
  return { hours };
}));

module.exports = router;
