const LegacyRule = require('../models/communicationReminderRuleModel');
const ActionRule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
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
 * Also disables active legacy rules and cancels their pending legacy runs so both engines never double-send.
 */
async function migrateLegacyReminderRules({ dryRun = false } = {}) {
  const legacyRules = await LegacyRule.find({ source: { $in: ['monthly_package', 'broadcast'] } }).sort({ createdAt: 1 }).lean();
  let migrated = 0;
  let skipped = 0;
  let disabledLegacy = 0;
  let cancelledRuns = 0;
  for (const old of legacyRules) {
    const legacyId = String(old._id);
    const alreadyMigrated = await ActionRule.exists({ migratedFrom: legacyId });
    if (alreadyMigrated) {
      skipped++;
    } else {
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

    if (old.enabled) {
      disabledLegacy++;
      if (!dryRun) {
        await LegacyRule.updateOne({ _id: old._id }, { $set: { enabled: false }, $inc: { revision: 1 } });
        const cancelled = await Run.updateMany(
          { ruleId: old._id, source: { $in: ['monthly_package', 'broadcast'] }, status: 'scheduled' },
          { $set: { status: 'cancelled', reason: 'Migrated to Action rules.' } },
        );
        cancelledRuns += Number(cancelled.modifiedCount || 0);
      }
    }
  }
  return { dryRun, total: legacyRules.length, migrated, skipped, disabledLegacy, cancelledRuns };
}

const ruleFingerprint = r => JSON.stringify([
  r.actionId || '', r.action, r.kind, r.audience, r.condition || 'anytime',
  r.scope?.kind || 'all', r.scope?.packageSlug || '',
  (r.steps || []).map(s => [s.timingRef, s.days, s.channel, s.subject || '', s.text]),
  r.repeat?.times || 0, r.repeat?.everyDays || 2,
  [...(r.stopOn || [])].sort(),
]);

/**
 * Removes exact duplicate ActionRules (only when they have no active scheduled/queued runs)
 * and links unpaired Customer+Admin rules created within 60s on the same action/kind/condition/scope.
 */
async function cleanupActionRules({ dryRun = true } = {}) {
  const all = await ActionRule.find().sort({ updatedAt: -1, createdAt: -1 }).lean();
  const byPrint = new Map();
  for (const r of all) {
    const key = ruleFingerprint(r);
    if (!byPrint.has(key)) byPrint.set(key, []);
    byPrint.get(key).push(r);
  }
  const duplicateIds = [];
  for (const group of byPrint.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => (Number(!!b.enabled) - Number(!!a.enabled)) || (+new Date(b.updatedAt) - +new Date(a.updatedAt)));
    for (const dup of group.slice(1)) {
      const hasActiveRuns = await Run.exists({ ruleId: dup._id, status: { $in: ['scheduled', 'preparing', 'queued'] } });
      if (!hasActiveRuns) duplicateIds.push(dup._id);
    }
  }
  if (!dryRun && duplicateIds.length) {
    await ActionRule.deleteMany({ _id: { $in: duplicateIds } });
  }

  const dupSet = new Set(duplicateIds.map(String));
  const remaining = all.filter(r => !dupSet.has(String(r._id)) && !r.pairId);
  const byPairScope = new Map();
  for (const r of remaining) {
    const key = [r.actionId || '', r.action, r.kind, r.condition || 'anytime', r.scope?.kind || 'all', r.scope?.packageSlug || ''].join('|');
    if (!byPairScope.has(key)) byPairScope.set(key, []);
    byPairScope.get(key).push(r);
  }
  let pairsLinked = 0;
  for (const group of byPairScope.values()) {
    const customers = group.filter(r => r.audience === 'customer');
    const admins = group.filter(r => r.audience === 'admin');
    if (customers.length === 1 && admins.length === 1) {
      const c = customers[0];
      const a = admins[0];
      if (Math.abs(+new Date(c.createdAt) - +new Date(a.createdAt)) <= 60000) {
        if (!dryRun) {
          const pairId = `pair-migrated-${c._id}`;
          await ActionRule.updateMany({ _id: { $in: [c._id, a._id] } }, { $set: { pairId } });
        }
        pairsLinked++;
      }
    }
  }
  return { dryRun, duplicatesRemoved: duplicateIds.length, pairsLinked };
}

module.exports = { migrateLegacyReminderRules, cleanupActionRules };
