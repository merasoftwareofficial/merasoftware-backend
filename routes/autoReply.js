const express = require('express');
const communicationAdmin = require('../middleware/communicationAdmin');
const { Inbox, Rule, State, STATE_ID } = require('../whatsapp/src/models.js');
const { DEFAULT_AD_MESSAGE, MIN_AD_MESSAGE, RULE_KEY, cleanText } = require('../whatsapp/src/autoReplyRules.js');
const { workerAlive } = require('../helpers/whatsappReadiness');

// The Auto Reply box (website Communication, through its /api/auto-reply proxy). Admins only: it holds people's messages.
const router = express.Router();
const RECENT_ROWS = 20;
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
  const [state, rule, rows, total, needsAttention] = await Promise.all([
    State.findById(STATE_ID).lean(),
    ensureRule(),
    Inbox.find().sort({ createdAt: -1 }).limit(RECENT_ROWS)
      .select('phone text profileName deliveredAs sentAt adMarker status createdAt').lean(),
    Inbox.countDocuments(),
    Inbox.countDocuments({ status: 'needs-attention' }),
  ]);
  return {
    switches: { recognise: !!state?.autoReply?.recognise, sendReplies: !!state?.autoReply?.sendReplies, addLeads: !!state?.autoReply?.addLeads },
    // Recognising needs the worker running and the number linked, whatever the switch says.
    listening: process.env.ENABLE_WHATSAPP === 'true' && workerAlive(state, new Date()) && state?.connection === 'connected',
    message: rule.message,
    minMessage: MIN_AD_MESSAGE,
    detected: { rows, total, needsAttention },
  };
}));

// Only recognising exists so far. The other two switches are added with the steps that make them do something.
router.post('/switches', handle(async req => {
  const { recognise } = req.body || {};
  if (typeof recognise !== 'boolean') fail('Choose On or Off.');
  await State.updateOne({ _id: STATE_ID }, { $set: { 'autoReply.recognise': recognise } }, { upsert: true });
  return { recognise };
}));

router.post('/message', handle(async req => {
  const message = String(req.body?.message || '').trim();
  if (cleanText(message).length < MIN_AD_MESSAGE) fail(`Write the ad's full message, at least ${MIN_AD_MESSAGE} letters. Short messages would match ordinary chats.`);
  if (message.length > 1_000) fail('This message is too long.');
  await ensureRule();
  await Rule.updateOne({ key: RULE_KEY }, { $set: { message } });
  return { message };
}));

module.exports = router;
