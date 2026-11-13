const Run = require('../models/communicationReminderRunModel');
const Rule = require('../models/communicationReminderRuleModel');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');

async function reminderHistory({ page = 1, pageSize = 20, view = 'all', source = 'all', now = new Date() } = {}) {
  page = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
  pageSize = Math.max(1, Math.min(50, Number.parseInt(pageSize, 10) || 20));
  if (!['all', 'upcoming', 'today', 'sent', 'sent_today', 'attention'].includes(view)) throw new Error('Choose a valid reminder view.');
  if (!['all', 'monthly_package', 'broadcast'].includes(source)) throw new Error('Choose a valid reminder source.');
  const dayStart = new Date(Math.floor((+now + 19800000) / 86400000) * 86400000 - 19800000);
  const filter = view === 'upcoming' ? { status: 'scheduled', dueAt: { $gt: now } }
    : view === 'today' ? { dueAt: { $gte: dayStart, $lt: new Date(+dayStart + 86400000) } }
    : view === 'sent_today' ? { status: 'sent', sentAt: { $gte: dayStart, $lt: new Date(+dayStart + 86400000) } }
    : view === 'sent' ? { status: 'sent' }
    : view === 'attention' ? { status: { $in: ['failed', 'partial', 'unknown', 'expired'] } } : {};
  if (source !== 'all') filter.source = source;
  const [rows, total] = await Promise.all([
    Run.find(filter).sort({ dueAt: view === 'upcoming' ? 1 : -1, _id: view === 'upcoming' ? 1 : -1 }).skip((page - 1) * pageSize).limit(pageSize)
      .select('ruleId clientId source cycle step dueAt sentAt status reason channel channelOutcomes').lean(),
    Run.countDocuments(filter),
  ]);
  const [users, leads, rules] = await Promise.all([
    User.find({ _id: { $in: rows.filter(row => row.source === 'monthly_package').map(row => row.clientId) } }).select('name email').lean(),
    Lead.find({ _id: { $in: rows.filter(row => row.source === 'broadcast').map(row => row.clientId) } }).select('name email phone').lean(),
    Rule.find({ _id: { $in: rows.map(row => row.ruleId) } }).select('name').lean(),
  ]);
  const names = new Map(users.map(user => [String(user._id), user.name || user.email || 'Customer']));
  const leadNames = new Map(leads.map(lead => [String(lead._id), lead.name || lead.email || lead.phone || 'Recipient']));
  const ruleNames = new Map(rules.map(rule => [String(rule._id), rule.name]));
  return { page, pageSize, view, total, rows: rows.map(row => ({ ...row, customer: (row.source === 'broadcast' ? leadNames : names).get(String(row.clientId)) || (row.source === 'broadcast' ? 'Recipient' : 'Customer'), ruleName: ruleNames.get(String(row.ruleId)) || 'Reminder' })) };
}
module.exports = { reminderHistory };
