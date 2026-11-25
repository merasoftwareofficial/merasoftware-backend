const Run = require('../models/communicationReminderRunModel');
const Rule = require('../models/communicationReminderRuleModel');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');

async function reminderHistory({ page = 1, pageSize = 20, view = 'all', source = 'all', now = new Date() } = {}) {
  page = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
  pageSize = Math.max(1, Math.min(50, Number.parseInt(pageSize, 10) || 20));
  if (!['all', 'upcoming', 'today', 'sent', 'sent_today', 'attention', 'cancelled'].includes(view)) throw new Error('Choose a valid reminder view.');
  if (!['all', 'monthly_package', 'broadcast', 'action'].includes(source)) throw new Error('Choose a valid reminder source.');
  const dayStart = new Date(Math.floor((+now + 19800000) / 86400000) * 86400000 - 19800000);
  const filter = view === 'upcoming' ? { status: 'scheduled', dueAt: { $gt: now } }
    : view === 'today' ? { dueAt: { $gte: dayStart, $lt: new Date(+dayStart + 86400000) } }
    : view === 'sent_today' ? { status: 'sent', sentAt: { $gte: dayStart, $lt: new Date(+dayStart + 86400000) } }
    : view === 'sent' ? { status: 'sent' }
    : view === 'attention' ? { status: { $in: ['failed', 'partial', 'unknown', 'expired'] } }
    : view === 'cancelled' ? { status: 'cancelled' }
    : { status: { $ne: 'cancelled' } };
  if (source !== 'all') filter.source = source;
  const [rows, total] = await Promise.all([
    Run.find(filter).sort({ dueAt: view === 'upcoming' ? 1 : -1, _id: view === 'upcoming' ? 1 : -1 }).skip((page - 1) * pageSize).limit(pageSize)
      .select('ruleId clientId leadId audience source runKind cycle step dueAt sentAt status reason channel channelOutcomes').lean(),
    Run.countDocuments(filter),
  ]);
  const userIds = rows.filter(row => row.source !== 'broadcast' && row.clientId).map(row => row.clientId);
  const leadIds = rows.map(row => (row.source === 'broadcast' ? row.clientId : (!row.clientId ? row.leadId : null))).filter(Boolean);
  const [users, leads, rules, actionRules] = await Promise.all([
    userIds.length ? User.find({ _id: { $in: userIds } }).select('name email').lean() : [],
    leadIds.length ? Lead.find({ _id: { $in: leadIds } }).select('name email phone').lean() : [],
    Rule.find({ _id: { $in: rows.map(row => row.ruleId) } }).select('name').lean(),
    require('../models/communicationActionRuleModel').find({ _id: { $in: rows.filter(row => row.source === 'action').map(row => row.ruleId) } }).select('name').lean(),
  ]);
  const names = new Map(users.map(user => [String(user._id), user.name || user.email || 'Customer']));
  const leadNames = new Map(leads.map(lead => [String(lead._id), lead.name || lead.email || lead.phone || 'Recipient']));
  const ruleNames = new Map([...rules, ...actionRules].map(rule => [String(rule._id), rule.name]));
  return {
    page,
    pageSize,
    view,
    total,
    rows: rows.map(row => {
      const customer = row.source === 'broadcast'
        ? (leadNames.get(String(row.clientId)) || 'Recipient')
        : (row.clientId ? names.get(String(row.clientId)) : leadNames.get(String(row.leadId))) || 'Customer';
      return {
        ...row,
        audience: row.audience || 'customer',
        customer,
        ruleName: ruleNames.get(String(row.ruleId)) || 'Reminder',
      };
    }),
  };
}
module.exports = { reminderHistory };
