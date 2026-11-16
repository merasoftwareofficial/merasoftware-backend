const LegacyRule = require('../models/communicationReminderRuleModel');
const ActionRule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const { EmailPolicy } = require('../models/emailControlModel');
const { createRule } = require('./actionRules');
const { isAdminRecipientEvent, isCustomerTriggered, byKey } = require('./emailCatalog');
const { resolveTemplate, systemTemplate } = require('./emailTemplates');

const TEMPLATE_SEEDS = [
  // Batch T1: Leads, Uploads, Orders/Invoices
  { event: 'lead.created', action: 'lead.created', actionId: 'A58' },
  { event: 'sendClientAccountCreatedEmail', action: 'client.account_created', actionId: 'A62' },
  { event: 'lead.proposal', action: 'lead.proposal', actionId: 'A63' },
  { event: 'lead.message', action: 'lead.message', actionId: 'A68' },
  { event: 'sendUpdateRequestNotification', action: 'upload.completed', actionId: 'A13' },
  { event: 'sendUserConfirmation', action: 'upload.completed', actionId: 'A13' },
  { event: 'sendAdminUPIPendingNotification', action: 'order.upi_pending', actionId: 'A104' },
  { event: 'invoice.project', action: 'invoice.resent', actionId: 'A111' },
  { event: 'sendMonthlyInvoiceEmail', action: 'invoice.resent', actionId: 'A112' },
  { event: 'invoice.reminder', action: 'invoice.manual_reminder', actionId: 'A113' },
  // Batch T2: Plans & Projects
  { event: 'plan.request.admin', action: 'plan.requested', actionId: 'A15' },
  { event: 'plan.request.received', action: 'plan.requested', actionId: 'A15' },
  { event: 'plan.started', action: 'plan.started', actionId: 'A29' },
  { event: 'plan.work_update', action: 'plan.work_updated', actionId: 'A53' },
  { event: 'plan.upload.in_progress', action: 'plan.upload_updated', actionId: 'A54' },
  { event: 'plan.upload.completed', action: 'plan.upload_updated', actionId: 'A54' },
  { event: 'plan.upload.rejected', action: 'plan.upload_updated', actionId: 'A54' },
  { event: 'plan.payment.received', action: 'payment.received', actionId: 'A91' },
  { event: 'plan.payment.rejected', action: 'plan.payment_rejected', actionId: 'A92' },
  { event: 'plan.purchase.admin', action: 'plan.purchased', actionId: 'A105' },
  { event: 'plan.payment.submitted', action: 'plan.purchased', actionId: 'A105' },
  { event: 'sendProjectCreatedEmail', action: 'project.created', actionId: 'A29' },
  { event: 'sendProjectCancellationEmail', action: 'project.cancelled', actionId: 'A44' },
  { event: 'project.upgrade.offer', action: 'project.upgraded', actionId: 'A45' },
  { event: 'project.upgrade.started', action: 'project.upgraded', actionId: 'A45' },
  { event: 'project.upgrade.completed', action: 'project.upgraded', actionId: 'A45' },
  { event: 'sendProjectUpdateEmail', action: 'project.step_updated', actionId: 'A114' },
  // Batch T3: Offers, Reservations, Packages & §C 9 active-flow templates
  { event: 'offer.reserved', action: 'reservation.created', actionId: 'B35' },
  { event: 'offer.reservation.extended', action: 'reservation.extended', actionId: 'B36' },
  { event: 'offer.start.request.admin', action: 'reservation.start_requested', actionId: 'B37' },
  { event: 'offer.start.request.received', action: 'reservation.start_requested', actionId: 'B37' },
  { event: 'package.start.request.admin', action: 'package.start_requested', actionId: 'B39' },
  { event: 'package.start.request.received', action: 'package.start_requested', actionId: 'B39' },
  { event: 'package.purchase.admin', action: 'package.purchased', actionId: 'B41' },
  { event: 'package.purchase.received', action: 'package.purchased', actionId: 'B41' },
  { event: 'sendPurchaseConfirmationEmail', action: 'invoice.created', actionId: 'A104' },
  { event: 'sendAdminPurchaseConfirmationEmail', action: 'invoice.created', actionId: 'A104' },
  { event: 'sendMonthlyLimitedPlanActivationEmail', action: 'plan.started', actionId: 'A51' },
  { event: 'sendWalletRechargeConfirmationEmail', action: 'wallet.recharged', actionId: 'A46' },
  { event: 'sendWalletRechargeRejectionEmail', action: 'plan.payment_rejected', actionId: 'A92' },
  { event: 'sendPaymentRejectionEmail', action: 'plan.payment_rejected', actionId: 'A92' },
  { event: 'sendAdminAutoRenewalNotification', action: 'plan.started', actionId: 'A51' },
  { event: 'sendPlanClosureEmailToCustomer', action: 'plan.closed', actionId: 'A109' },
  { event: 'sendPlanClosureEmailToAdmin', action: 'plan.closed', actionId: 'A109' },
];

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

const BUILTIN_REMINDER_SEEDS = [
  {
    migratedFrom: 'builtin:B37',
    kind: 'reminder',
    action: 'reservation.start_requested',
    actionId: 'B37',
    audience: 'admin',
    condition: 'anytime',
    scope: { kind: 'all' },
    steps: [{
      timingRef: 'after_action',
      unit: 'days',
      days: 1,
      channel: 'both',
      subject: 'Pending reservation start request',
      text: 'Reminder: {{name}} requested to start their reserved offer project. Please review and create the project.',
    }],
    repeat: { everyDays: 1, times: 2, perDay: 1 },
    stopOn: ['project.created', 'start_request.closed'],
    doAlso: [],
    control: 'auto',
    enabled: true,
  },
  {
    migratedFrom: 'builtin:B39',
    kind: 'reminder',
    action: 'package.start_requested',
    actionId: 'B39',
    audience: 'admin',
    condition: 'anytime',
    scope: { kind: 'all' },
    steps: [{
      timingRef: 'after_action',
      unit: 'days',
      days: 1,
      channel: 'both',
      subject: 'Pending package start request',
      text: 'Reminder: {{name}} requested to start a package project. Please review and follow up.',
    }],
    repeat: { everyDays: 1, times: 2, perDay: 1 },
    stopOn: ['project.created', 'start_request.closed'],
    doAlso: [],
    control: 'auto',
    enabled: true,
  },
  {
    migratedFrom: 'builtin:B35',
    kind: 'reminder',
    action: 'reservation.created',
    actionId: 'B35',
    audience: 'customer',
    condition: 'anytime',
    scope: { kind: 'all' },
    steps: [
      { timingRef: 'after_action', unit: 'hours', hours: 24, channel: 'both', subject: '24 hours passed on your offer reservation', text: 'Hi {{name}}, 24 hours have passed since you reserved your offer. Complete your project start before the deadline.' },
      { timingRef: 'before_due', unit: 'hours', hours: 24, channel: 'both', subject: '24 hours left on your offer reservation', text: 'Hi {{name}}, only 24 hours are left on your reserved offer.' },
      { timingRef: 'before_due', unit: 'hours', hours: 6, channel: 'both', subject: '6 hours left on your offer reservation', text: 'Hi {{name}}, only 6 hours are left on your reserved offer.' },
      { timingRef: 'before_due', unit: 'hours', hours: 1, channel: 'both', subject: '1 hour left on your offer reservation', text: 'Hi {{name}}, final 1 hour left on your reserved offer.' },
    ],
    repeat: { times: 0 },
    stopOn: ['project.created', 'reservation.expired', 'reservation.start_requested'],
    doAlso: [],
    control: 'auto',
    enabled: true,
  },
  {
    migratedFrom: 'builtin:A66',
    kind: 'reminder',
    action: 'lead.final_message_started',
    actionId: 'A66',
    audience: 'customer',
    condition: 'anytime',
    scope: { kind: 'all' },
    steps: [{
      timingRef: 'after_action',
      unit: 'hours',
      hours: 24,
      channel: 'whatsapp',
      subject: '',
      text: 'Hi {{name}}, checking in on our last message. Let us know if you would like to continue.',
    }],
    repeat: { times: 0 },
    stopOn: ['whatsapp.ad_received', 'final_message.stopped'],
    doAlso: [],
    control: 'auto',
    enabled: true,
  },
  {
    migratedFrom: 'builtin:offer_payment',
    kind: 'reminder',
    action: 'invoice.created',
    actionId: 'A104',
    audience: 'customer',
    condition: 'unpaid',
    scope: { kind: 'offer_payment' },
    steps: [{
      timingRef: 'before_due',
      unit: 'days',
      days: 1,
      channel: 'email',
      subject: 'Offer payment reminder',
      text: 'Hi {{name}}, your offer payment of ₹{{amount}} is due on {{dueDate}}. Pay here: {{invoiceLink}}',
    }],
    repeat: { times: 0 },
    stopOn: ['payment.received'],
    doAlso: [],
    control: 'auto',
    enabled: true,
  },
];

/**
 * Idempotently migrates legacy `monthly_package` and `broadcast` reminder rules into `ActionRule`
 * with `origin: 'migrated'` and `migratedFrom` set to the legacy rule ID, plus built-in reminder workflows.
 * Also disables active legacy rules and cancels their pending legacy runs so both engines never double-send.
 */
async function migrateLegacyReminderRules({ dryRun = false, actorId = null } = {}) {
  const legacyRules = await LegacyRule.find({ source: { $in: ['monthly_package', 'broadcast'] } }).sort({ createdAt: 1 }).lean();
  let migrated = 0;
  let skipped = 0;
  let disabledLegacy = 0;
  let cancelledRuns = 0;
  let fallbackActor = actorId || legacyRules[0]?.createdBy || null;
  if (!fallbackActor) {
    const existingRule = await ActionRule.findOne().select('createdBy').lean();
    fallbackActor = existingRule?.createdBy || null;
  }
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
  for (const seed of BUILTIN_REMINDER_SEEDS) {
    const exists = await ActionRule.exists({ migratedFrom: seed.migratedFrom });
    if (exists) {
      skipped++;
      continue;
    }
    if (!dryRun && fallbackActor) {
      await createRule({ ...seed, origin: 'migrated' }, fallbackActor);
    }
    if (dryRun || fallbackActor) migrated++;
  }
  for (const tpl of TEMPLATE_SEEDS) {
    const migratedFrom = `template:${tpl.event}`;
    const exists = await ActionRule.exists({ migratedFrom });
    if (exists) {
      skipped++;
      continue;
    }
    if (!dryRun && fallbackActor) {
      const policy = await EmailPolicy.findOne({ event: tpl.event }).lean();
      const loaded = (policy?.defaultTemplate ? await resolveTemplate(tpl.event, policy.defaultTemplate).catch(() => null) : null)
        || await systemTemplate(tpl.event).catch(() => null);
      const meta = byKey.get(tpl.event);
      const subject = String(loaded?.subject || meta?.label || tpl.event).trim();
      const text = String(loaded?.text || meta?.label || tpl.event).trim();
      let control = 'review';
      if (policy?.mode === 'off') control = 'off';
      else if (isCustomerTriggered(tpl.event)) control = policy?.mode === 'auto' ? 'auto' : 'off';
      else if (meta?.trigger === 'system') control = 'auto';
      else if (policy?.mode) control = policy.mode;
      const channel = ['email', 'whatsapp', 'both'].includes(policy?.channel) ? policy.channel : 'both';
      await createRule({
        kind: 'template',
        action: tpl.action,
        actionId: tpl.actionId,
        audience: isAdminRecipientEvent(tpl.event) ? 'admin' : 'customer',
        condition: 'anytime',
        scope: { kind: 'all' },
        steps: [{ timingRef: 'after_action', unit: 'days', days: 0, channel, subject: channel === 'whatsapp' ? '' : subject, text }],
        repeat: { times: 0 },
        stopOn: [],
        doAlso: [],
        control,
        enabled: control !== 'off',
        origin: 'migrated',
        migratedFrom,
      }, fallbackActor);
    }
    if (dryRun || fallbackActor) migrated++;
  }
  return { dryRun, total: legacyRules.length + BUILTIN_REMINDER_SEEDS.length + TEMPLATE_SEEDS.length, migrated, skipped, disabledLegacy, cancelledRuns };
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
