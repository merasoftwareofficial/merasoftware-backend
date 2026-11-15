const express = require('express');
const ActionRule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { ACTIONS } = require('../helpers/actionEvents');
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

router.get('/runs', handle(async () => {
  const runs = await Run.find({ source: 'action', status: 'scheduled' }).sort({ dueAt: 1 }).limit(200).lean();
  if (!runs.length) return [];
  const clientIds = [...new Set(runs.map(r => String(r.clientId || '')).filter(Boolean))];
  const leadIds = [...new Set(runs.filter(r => !r.clientId && r.leadId).map(r => String(r.leadId)))];
  const ruleIds = [...new Set(runs.map(r => String(r.ruleId || '')).filter(Boolean))];
  const [users, leads, rules] = await Promise.all([
    clientIds.length ? User.find({ _id: { $in: clientIds } }).select('name email phone').lean() : [],
    leadIds.length ? Lead.find({ _id: { $in: leadIds } }).select('name email phone').lean() : [],
    ruleIds.length ? ActionRule.find({ _id: { $in: ruleIds } }).lean() : [],
  ]);
  const userById = new Map(users.map(u => [String(u._id), u]));
  const leadById = new Map(leads.map(l => [String(l._id), l]));
  const ruleById = new Map(rules.map(r => [String(r._id), r]));
  return runs.map(run => {
    const user = userById.get(String(run.clientId)) || leadById.get(String(run.leadId));
    const rule = ruleById.get(String(run.ruleId));
    return {
      ...run,
      ruleName: rule?.name || ACTIONS[run.action]?.label || run.action || 'Action rule',
      actionLabel: ACTIONS[run.action]?.label || run.action || '',
      origin: rule?.origin || 'new',
      rule: rule || null,
      customer: user ? { name: user.name || 'Customer', email: user.email || '', phone: user.phone || '' } : { name: 'Unknown customer', email: '', phone: '' },
    };
  });
}));

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
