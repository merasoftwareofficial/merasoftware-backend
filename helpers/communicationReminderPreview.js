const Rule = require('../models/communicationReminderRuleModel');
const Order = require('../models/orderProductModel');
const Invoice = require('../models/invoiceModel');
const User = require('../models/userModel');
const { getNextCycleNumber } = require('./serviceBillingSchedule');
const { packageReminderCandidate } = require('./packageReminderEligibility');
const { planPackageRuns } = require('./packageReminderSchedule');

// Read only and bounded. The estimate is not an enrollment; live eligibility is
// checked again by the worker and immediately at each provider handoff.
async function previewMonthlyRule(id, now = new Date()) {
  const saved = await Rule.findById(id).lean();
  if (!saved || saved.source !== 'monthly_package' || saved.enabled) throw new Error('Choose an inactive monthly package rule.');
  require('./communicationReminderRules').validateDraft({ ...saved, enabled: false });
  const rule = { ...saved, enabled: true, activatedAt: now };
  const cursor = Order.find({ isServicePlan: true, 'salesPackage.package.id': { $exists: true, $ne: null }, paymentPolicy: null,
    orderVisibility: { $ne: 'cancelled' }, servicePlanStatus: { $in: ['active', 'paused', 'expired'] } }).sort({ _id: 1 }).limit(5001).cursor();
  let scanned = 0, count = 0, truncated = false;
  const sample = [];
  for await (const order of cursor) {
    if (++scanned > 5000) { truncated = true; break; }
    const invoices = await Invoice.find({ orderId: order._id, invoiceType: 'plan_renewal' }).lean();
    const nextCycle = getNextCycleNumber(order);
    const candidates = invoices.filter(invoice => ['unpaid', 'partially_paid', 'overdue'].includes(invoice.status));
    if (!invoices.some(invoice => Number(invoice.serviceCycleNumber) === nextCycle)) candidates.push(null);
    for (const invoice of candidates) {
      const candidate = packageReminderCandidate(order, invoice), plans = planPackageRuns(rule, order, invoice);
      if (!candidate || !plans.length) continue;
      count++;
      if (sample.length < 20) sample.push({ userId: order.userId, due: candidate.due, amount: candidate.amount, steps: plans.length });
    }
  }
  const users = await User.find({ _id: { $in: sample.map(row => row.userId) } }).select('name email').lean();
  const names = new Map(users.map(user => [String(user._id), user.name || user.email || 'Customer']));
  return { count, truncated, samples: sample.map(row => ({ customer: names.get(String(row.userId)) || 'Customer', due: row.due, amount: row.amount, steps: row.steps })) };
}
async function previewRule(id, now = new Date()) {
  const saved = await Rule.findById(id).lean();
  if (!saved || saved.enabled) throw new Error('Choose an inactive reminder rule.');
  if (saved.source === 'monthly_package') return { source: saved.source, ...await previewMonthlyRule(id, now) };
  require('./communicationReminderRules').validateDraft({ ...saved, enabled: false });
  // Future broadcast recipients cannot be known at activation time. Do not
  // pretend old broadcasts are an enrollment estimate or send to them.
  return { source: 'broadcast', count: 0, truncated: false, samples: [] };
}
module.exports = { previewMonthlyRule, previewRule };
