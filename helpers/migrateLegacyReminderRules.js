const LegacyRule = require('../models/communicationReminderRuleModel');
const ActionRule = require('../models/communicationActionRuleModel');
const { createRule } = require('./actionRules');

function mapMonthlyStep(step) {
  const offset = Number(step.offsetDays || 0);
  if (offset < 0) return { timingRef: 'before_due', days: Math.abs(offset), channel: step.channel, subject: step.subject || '', text: step.text };
  if (offset === 0) return { timingRef: 'on_due', days: 0, channel: step.channel, subject: step.subject || '', text: step.text };
  return { timingRef: 'after_due', days: offset, channel: step.channel, subject: step.subject || '', text: step.text };
}

function mapBroadcastStep(step) {
  return {
    timingRef: 'after_action',
    days: Math.max(0, Number(step.offsetDays || 0)),
    channel: step.channel,
    subject: step.subject || '',
    text: step.text,
  };
}

/**
 * Idempotently migrates legacy `monthly_package` and `broadcast` reminder rules into `ActionRule`
 * with `origin: 'migrated'` and `migratedFrom` set to the legacy rule ID.
 */
async function migrateLegacyReminderRules({ dryRun = false } = {}) {
  const legacyRules = await LegacyRule.find({ source: { $in: ['monthly_package', 'broadcast'] } }).sort({ createdAt: 1 }).lean();
  let migrated = 0;
  let skipped = 0;
  for (const old of legacyRules) {
    const legacyId = String(old._id);
    if (await ActionRule.exists({ migratedFrom: legacyId })) {
      skipped++;
      continue;
    }
    const isMonthly = old.source === 'monthly_package';
    const payload = {
      kind: 'reminder',
      action: isMonthly ? 'invoice.created' : 'broadcast.sent',
      actionId: isMonthly ? 'A104' : 'B05',
      audience: 'customer',
      condition: isMonthly ? 'unpaid' : 'anytime',
      scope: isMonthly ? { kind: 'monthly' } : { kind: 'all' },
      steps: (old.steps || []).map(isMonthly ? mapMonthlyStep : mapBroadcastStep),
      repeat: { times: 0 },
      stopOn: isMonthly ? ['payment.received'] : ['whatsapp.ad_received'],
      doAlso: [],
      control: old.enabled ? 'auto' : 'off',
      enabled: !!old.enabled,
      origin: 'migrated',
      migratedFrom: legacyId,
    };
    if (!dryRun) {
      await createRule(payload, old.createdBy);
    }
    migrated++;
  }
  return { total: legacyRules.length, migrated, skipped };
}

module.exports = { migrateLegacyReminderRules };
