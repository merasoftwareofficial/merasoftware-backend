const { packageReminderCandidate } = require('./packageReminderEligibility');
const { DAY } = require('./offerPaymentPolicy');

// Build prospective step records only. This does not enqueue or deliver; the
// eventual dispatcher must re-read payment, order and rule state at handoff.
function planPackageRuns(rule, order, invoice = null) {
  if (!rule?.enabled || rule.source !== 'monthly_package' || !rule.activatedAt || !order?.userId) return [];
  const activatedAt = new Date(rule.activatedAt);
  const candidate = packageReminderCandidate(order, invoice);
  if (!candidate || !Number.isFinite(+activatedAt) || candidate.due <= activatedAt) return [];
  return (rule.steps || []).flatMap((step, index) => {
    const dueAt = new Date(+candidate.due + Number(step.offsetDays) * DAY);
    if (!Number.isFinite(+dueAt) || dueAt < activatedAt) return [];
    return [{ ruleId: rule._id, ruleRevision: rule.revision, source: 'monthly_package',
      occurrenceKey: `${candidate.orderId}:${candidate.cycle}`, step: index, entityId: order._id, clientId: order.userId,
      cycle: candidate.cycle, anchorAt: candidate.due, dueAt, subject: step.subject, text: step.text, channel: step.channel }];
  });
}

// Idempotent persistence of plans; never contacts a channel. A duplicate-key
// collision means another scheduler persisted the same identity first.
async function persistPackageRuns(plans) {
  const Run = require('../models/communicationReminderRunModel');
  for (const plan of plans) {
    const key = { ruleId: plan.ruleId, ruleRevision: plan.ruleRevision, occurrenceKey: plan.occurrenceKey, step: plan.step };
    const { dueAt, anchorAt, ...initial } = plan;
    // A newly issued invoice can carry a different actual due date. Only a
    // never-attempted scheduled run can move; sent/queued/failed runs stay frozen.
    try { await Run.updateOne({ ...key, status: 'scheduled' }, { $set: { dueAt, anchorAt }, $setOnInsert: initial }, { upsert: true, runValidators: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
}
module.exports = { planPackageRuns, persistPackageRuns };
