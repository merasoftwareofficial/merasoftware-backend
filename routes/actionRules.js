const express = require('express');
const ActionRule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { createRule, updateRule, setRuleEnabled, deleteRule } = require('../helpers/actionRules');

// Mounted under /api/auto-reply/action-rules (admin only, via routes/autoReply.js).
const router = express.Router();
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (error) { res.status(error.status || 400).json({ success: false, message: error.message }); }
};

router.get('/', handle(() => ActionRule.find().sort({ createdAt: -1 }).lean()));
router.post('/', handle(req => createRule(req.body || {}, req.userId)));
router.put('/:id', handle(req => updateRule(req.params.id, req.body || {})));
router.post('/:id/enabled', handle(req => setRuleEnabled(req.params.id, !!req.body?.enabled)));
router.post('/:id/delete', handle(req => deleteRule(req.params.id)));

router.get('/runs', handle(() => Run.find({ source: 'action', status: 'scheduled' }).sort({ dueAt: 1 }).limit(200).lean()));
router.post('/runs/:id/cancel', handle(async req => {
  const run = await Run.findOneAndUpdate(
    { _id: req.params.id, source: 'action', status: 'scheduled' },
    { $set: { status: 'cancelled', reason: 'Cancelled by admin.' } },
    { new: true },
  ).lean();
  if (!run) throw Object.assign(new Error('Scheduled reminder not found.'), { status: 404 });
  return run;
}));

module.exports = router;
