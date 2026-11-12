const Rule = require('../models/communicationReminderRuleModel');
const Run = require('../models/communicationReminderRunModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const User = require('../models/userModel');
const { packageReminderCandidate } = require('./packageReminderEligibility');

// Fail closed. This is only a building block: callers must perform this check
// immediately before each channel handoff, not only when the run is planned.
async function maySendReminder(runId, target = {}) {
  const run = await Run.findById(runId).lean();
  if (!run || !['scheduled', 'preparing', 'queued', 'failed', 'partial'].includes(run.status)) return { allowed: false, reason: 'Reminder is no longer pending.' };
  const rule = await Rule.findOne({ _id: run.ruleId, enabled: true, revision: run.ruleRevision }).lean();
  if (!rule) return { allowed: false, reason: 'Rule is unavailable.' };
  if (run.status === 'preparing' && run.workerLeaseOwner && (rule.workerLeaseOwner !== run.workerLeaseOwner || !rule.workerLeaseUntil || rule.workerLeaseUntil <= new Date())) return { allowed: false, reason: 'Reminder worker lease expired.' };
  if (run.source === 'broadcast' && rule.source === 'broadcast') {
    const requireName = /\{\{\s*name\s*\}\}/.test(`${run.subject}\n${run.text}`);
    const candidate = await require('./broadcastReminderCandidates').eligibleBroadcastReminder(run.entityId, run.clientId, rule.activatedAt, run.anchorAt, { requireName });
    if (!candidate) return { allowed: false, reason: 'Broadcast recipient or audience changed.' };
    const emails = [...new Set(candidate.recipients.filter(row => row.channel === 'email').map(row => row.email))];
    const phones = [...new Set(candidate.recipients.filter(row => row.channel === 'whatsapp').map(row => row.phone))];
    if ((run.channel !== 'whatsapp' && emails.length !== 1) || (run.channel !== 'email' && !phones.length)) return { allowed: false, reason: 'The original broadcast did not reach the required channels.' };
    if (target.phone && !phones.includes(target.phone)) return { allowed: false, reason: 'WhatsApp destination changed.' };
    if (target.emails && (target.emails.length !== 1 || target.emails[0] !== emails[0])) return { allowed: false, reason: 'Email destination changed.' };
    return { allowed: true, candidate: { ...candidate, emails, phones } };
  }
  if (run.source !== 'monthly_package' || rule.source !== 'monthly_package') return { allowed: false, reason: 'Reminder source is not supported yet.' };
  const client = await User.findById(run.clientId).select('isActive isGuest deletedAt').lean();
  if (!client || client.isActive === false || client.isGuest || client.deletedAt) return { allowed: false, reason: 'Client is unavailable.' };
  const order = await Order.findById(run.entityId).lean();
  if (!order || String(order.userId) !== String(run.clientId)) return { allowed: false, reason: 'Package is unavailable.' };
  // Look for an invoice regardless of status: a paid invoice must not fall back
  // to the projected candidate and accidentally trigger an unpaid reminder.
  const invoice = await Invoice.findOne({ orderId: order._id, invoiceType: 'plan_renewal', serviceCycleNumber: run.cycle }).lean();
  const candidate = packageReminderCandidate(order, invoice || null);
  if (!candidate || candidate.cycle !== run.cycle || !run.anchorAt || +candidate.due !== +new Date(run.anchorAt)) return { allowed: false, reason: 'Payment, package or due date changed.' };
  // A projected future charge is useful before the boundary. Once that boundary
  // has passed, never claim a bill exists unless the billing engine made one.
  if (!invoice && new Date() >= candidate.due) return { allowed: false, reason: 'The renewal invoice is not available yet.' };
  if (run.expectedAmount != null && Math.round(Number(run.expectedAmount) * 100) !== Math.round(candidate.amount * 100)) return { allowed: false, reason: 'The outstanding amount changed.' };
  return { allowed: true, candidate };
}
module.exports = { maySendReminder };
