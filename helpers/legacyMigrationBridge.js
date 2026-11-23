const mongoose = require('mongoose');
const { EmailTemplate, EmailPolicy } = require('../models/emailControlModel');
const ActionRule = require('../models/communicationActionRuleModel');
const { byKey, isAdminRecipientEvent, channelFor, isAutomaticEvent } = require('./emailCatalog');
const { definitions } = require('./emailDefinitions');

/**
 * Isolated, removable bridge for Trigger-Aware 1-click "Get Legacy" migration (Instruction #10).
 * - Zero runtime dependency from the new Automated Message System on legacy models.
 * - Reads unmigrated legacy templates & reminder rules for selected Trigger Points (read-only).
 * - On Trail Save, stamps `migratedToTrailId` and sets superseded legacy policies/rules to `off`
 *   so old & new systems never double-send and migrated items never re-appear in "Get Legacy".
 * - Once all needed triggers are migrated & verified, this file can be cleanly deleted.
 */

// Explicit Trigger Point -> legacy emailCatalog events map (verified against helpers/emailCatalog.js).
// Essential transactional OTP (`auth.otp`) and standalone systems (`lead.finalMessage`, `offer.reserved`,
// `offer.reservation.*`, `broadcast.manual`) are intentionally excluded.
const LEGACY_EVENTS_BY_TRIGGER = {
  'lead.created': ['lead.created'],
  'lead.proposal': ['lead.proposal'],
  'lead.message': ['lead.message'],
  'client.account_created': ['sendClientAccountCreatedEmail'],
  'package.purchased': ['package.purchase.received', 'package.purchase.admin', 'sendPurchaseConfirmationEmail', 'sendAdminPurchaseConfirmationEmail'],
  'plan.purchased': ['plan.started', 'plan.purchase.admin', 'sendMonthlyLimitedPlanActivationEmail'],
  'plan.started': ['plan.started', 'sendMonthlyLimitedPlanActivationEmail'],
  'plan.requested': ['plan.request.received', 'plan.request.admin'],
  'package.start_requested': ['package.start.request.received', 'package.start.request.admin'],
  'plan.work_updated': ['plan.work_update'],
  'plan.upload_updated': ['plan.upload.in_progress', 'plan.upload.completed', 'plan.upload.rejected'],
  'plan.closed': ['sendPlanClosureEmailToCustomer', 'sendPlanClosureEmailToAdmin'],
  'upload.completed': ['sendUserConfirmation', 'sendUpdateRequestNotification', 'sendUpdateCompletedNotification'],
  'project.created': ['sendProjectCreatedEmail'],
  'project.step_updated': ['sendProjectUpdateEmail', 'sendProjectMessageEmail'],
  'project.cancelled': ['sendProjectCancellationEmail'],
  'project.upgraded': ['project.upgrade.offer', 'project.upgrade.started', 'project.upgrade.completed'],
  'invoice.created': ['invoice.project', 'sendMonthlyInvoiceEmail'],
  'invoice.resent': ['invoice.project', 'sendMonthlyInvoiceEmail'],
  'invoice.manual_reminder': ['invoice.reminder'],
  'order.upi_pending': ['sendAdminUPIPendingNotification', 'plan.payment.submitted'],
  'payment.received': ['plan.payment.received'],
  'plan.payment_rejected': ['plan.payment.rejected', 'sendPaymentRejectionEmail'],
  'wallet.recharged': ['sendWalletRechargeConfirmationEmail', 'sendWalletRechargeRejectionEmail'],
  'subscription.updated': ['website.subscription.confirm', 'website.subscription.manage'],
};

function mapRuleStepToForm(st = {}) {
  const pos = st.timingRef === 'on_due' ? 'on' : st.timingRef === 'before_due' ? 'before' : 'after';
  const unit = st.unit === 'hours' ? 'hours' : 'days';
  const amount = unit === 'hours' ? Number(st.hours ?? 0) : Number(st.days ?? st.afterDays ?? 0);
  return {
    pos,
    unit,
    amount: Number.isFinite(amount) ? Math.max(0, amount) : 0,
    channel: ['whatsapp', 'email', 'both'].includes(st.channel) ? st.channel : 'whatsapp',
    subject: String(st.subject || '').trim(),
    text: String(st.text || '').trim(),
  };
}

function mapLegacyRuleToFormReminder(rule) {
  const steps = (Array.isArray(rule.steps) ? rule.steps : []).map(mapRuleStepToForm).filter(st => st.text);
  if (!steps.length) return null;
  const isAdmin = rule.audience === 'admin';
  const repeatMode = rule.repeat?.mode === 'permanent'
    ? 'permanent'
    : (rule.repeat?.mode === 'limited' || (rule.repeat?.times || 0) > 0) ? 'limited' : 'off';
  let condition = 'any';
  let conditionValue = 50;
  if (Number(rule.minProgress || 0) > 0) {
    condition = 'progress_min';
    conditionValue = Number(rule.minProgress);
  } else if (rule.minRemainingLimit !== null && rule.minRemainingLimit !== undefined) {
    condition = 'limit_min';
    conditionValue = Number(rule.minRemainingLimit);
  } else if (rule.maxRemainingLimit !== null && rule.maxRemainingLimit !== undefined) {
    condition = 'limit_max';
    conditionValue = Number(rule.maxRemainingLimit);
  } else if (['unpaid', 'pending_approval', 'installment_due', 'upload_pending', 'paid'].includes(rule.condition)) {
    condition = rule.condition;
  }

  return {
    startTrigger: '__main__',
    audience: isAdmin ? 'admin' : 'client',
    clientMode: 'separate',
    adminMode: 'separate',
    clientSteps: isAdmin ? [{ pos: 'after', unit: 'days', amount: 1, channel: 'whatsapp', subject: '', text: '' }] : steps,
    adminSteps: isAdmin ? steps : [{ pos: 'after', unit: 'days', amount: 1, channel: 'whatsapp', subject: '', text: '' }],
    repeatMode,
    repeatForDays: Math.max(1, Number(rule.repeat?.forDays || ((rule.repeat?.times || 1) * (rule.repeat?.everyDays || 1)))),
    repeatEveryDays: Math.max(1, Number(rule.repeat?.everyDays || 2)),
    repeatPerDay: Math.min(4, Math.max(1, Number(rule.repeat?.perDay || 1))),
    countDaysFrom: ['trigger_date', 'due_date', 'expiry_date', 'deadline_date'].includes(rule.baseDate) ? rule.baseDate : 'due_date',
    condition,
    conditionValue,
    stopOn: Array.isArray(rule.stopOn) ? rule.stopOn : [],
    stopChains: {},
  };
}

async function getLegacyForTriggers(triggerKeys = []) {
  const cleanTriggers = [...new Set((Array.isArray(triggerKeys) ? triggerKeys : []).map(s => String(s || '').trim()).filter(Boolean))];
  if (!cleanTriggers.length) {
    return { clientTemplates: [], adminTemplates: [], reminders: [], control: 'auto', events: [], templateIds: [], ruleIds: [] };
  }

  const mappedEvents = [...new Set(cleanTriggers.flatMap(t => LEGACY_EVENTS_BY_TRIGGER[t] || []))];

  const [policies, dbTemplates, legacyRules] = await Promise.all([
    mappedEvents.length
      ? EmailPolicy.find({ event: { $in: mappedEvents } }).lean()
      : [],
    mappedEvents.length
      ? EmailTemplate.find({ event: { $in: mappedEvents }, migratedToTrailId: null }).sort({ system: -1, name: 1 }).lean()
      : [],
    ActionRule.find({
      trailId: null,
      migratedToTrailId: null,
      kind: 'reminder',
      $or: [{ action: { $in: cleanTriggers } }, { actions: { $in: cleanTriggers } }],
    }).sort({ createdAt: 1 }).lean(),
  ]);

  const policyByEvent = new Map(policies.map(p => [p.event, p]));
  const templatesByEvent = new Map();
  for (const tpl of dbTemplates) {
    const list = templatesByEvent.get(tpl.event) || [];
    list.push(tpl);
    templatesByEvent.set(tpl.event, list);
  }

  // Filter out events whose policy is already stamped migratedToTrailId.
  const activeEvents = mappedEvents.filter(ev => !policyByEvent.get(ev)?.migratedToTrailId);
  const clientTemplates = [];
  const adminTemplates = [];
  const pulledEvents = [];
  const pulledTemplateIds = [];
  let adminWantsReview = false;
  let adminExplicitOff = false;
  let userWantsAuto = false;
  let userExplicitOff = false;

  const clientEventCount = activeEvents.filter(ev => !isAdminRecipientEvent(ev) && byKey.get(ev)?.audience !== 'team').length;
  const adminEventCount = activeEvents.length - clientEventCount;

  for (const ev of activeEvents) {
    const policy = policyByEvent.get(ev) || null;
    const channel = channelFor(ev, policy);
    const isAdmin = isAdminRecipientEvent(ev) || byKey.get(ev)?.audience === 'team';
    const meta = byKey.get(ev);
    const needsPrefix = isAdmin ? adminEventCount > 1 : clientEventCount > 1;
    const prefix = needsPrefix && meta?.label ? `${meta.label} — ` : '';

    if (isAutomaticEvent(ev)) {
      if (policy?.mode === 'auto') userWantsAuto = true;
      else if (policy?.mode === 'off') userExplicitOff = true;
    } else {
      const effectiveMode = policy?.mode || 'review';
      if (effectiveMode === 'review') adminWantsReview = true;
      else if (effectiveMode === 'off') adminExplicitOff = true;
    }

    const rows = templatesByEvent.get(ev) || [];
    if (rows.length > 0) {
      pulledEvents.push(ev);
      const defaultId = policy?.defaultTemplate ? String(policy.defaultTemplate) : '';
      const hasExplicitDefault = defaultId && rows.some(r => String(r._id) === defaultId);
      rows.forEach((row, idx) => {
        pulledTemplateIds.push(String(row._id));
        const item = {
          id: String(row._id),
          name: `${prefix}${row.name || 'Default'}`.slice(0, 100),
          channel,
          subject: String(row.subject || '').trim(),
          text: String(row.text || '').trim(),
          isDefault: hasExplicitDefault ? String(row._id) === defaultId : idx === 0,
        };
        if (isAdmin) adminTemplates.push(item);
        else clientTemplates.push(item);
      });
    } else if (definitions[ev]?.text) {
      // Built-in wording fallback (read-only — never writes to EmailTemplate).
      pulledEvents.push(ev);
      const def = definitions[ev];
      const item = {
        id: new mongoose.Types.ObjectId().toString(),
        name: `${prefix}Standard`.slice(0, 100),
        channel,
        subject: String(def.subject || '').trim(),
        text: String(def.text || '').trim(),
        isDefault: true,
      };
      if (isAdmin) adminTemplates.push(item);
      else clientTemplates.push(item);
    }
  }

  // Ensure exactly one default per audience list.
  const ensureSingleDefault = list => {
    if (!list.length) return;
    let defIdx = list.findIndex(t => t.isDefault);
    if (defIdx < 0) defIdx = 0;
    list.forEach((t, i) => { t.isDefault = i === defIdx; });
  };
  ensureSingleDefault(clientTemplates);
  ensureSingleDefault(adminTemplates);

  const reminders = [];
  const pulledRuleIds = [];
  for (const rule of legacyRules) {
    const mapped = mapLegacyRuleToFormReminder(rule);
    if (!mapped) continue;
    reminders.push(mapped);
    pulledRuleIds.push(String(rule._id));
  }

  const adminActionControl = adminWantsReview ? 'review' : (adminExplicitOff ? 'off' : 'auto');
  const userActionControl = userWantsAuto ? 'auto' : (userExplicitOff ? 'off' : 'auto');

  return {
    clientTemplates,
    adminTemplates,
    reminders,
    control: adminWantsReview ? 'review' : 'auto',
    adminActionControl,
    userActionControl,
    events: [...new Set(pulledEvents)],
    templateIds: [...new Set(pulledTemplateIds)],
    ruleIds: [...new Set(pulledRuleIds)],
  };
}

async function stampMigratedLegacy(trailId, migratedLegacy) {
  if (!trailId || !migratedLegacy || typeof migratedLegacy !== 'object') return;
  const events = [...new Set((Array.isArray(migratedLegacy.events) ? migratedLegacy.events : []).map(s => String(s || '').trim()).filter(Boolean))];
  const templateIds = [...new Set((Array.isArray(migratedLegacy.templateIds) ? migratedLegacy.templateIds : []).filter(id => mongoose.isValidObjectId(id)))];
  const ruleIds = [...new Set((Array.isArray(migratedLegacy.ruleIds) ? migratedLegacy.ruleIds : []).filter(id => mongoose.isValidObjectId(id)))];

  const ops = [];
  if (templateIds.length) {
    ops.push(EmailTemplate.updateMany(
      { _id: { $in: templateIds } },
      { $set: { migratedToTrailId: trailId } },
    ));
  }
  if (events.length) {
    ops.push(EmailTemplate.updateMany(
      { event: { $in: events }, migratedToTrailId: null },
      { $set: { migratedToTrailId: trailId } },
    ));
    for (const ev of events) {
      ops.push(EmailPolicy.findOneAndUpdate(
        { event: ev },
        { $set: { mode: 'off', migratedToTrailId: trailId } },
        { upsert: true },
      ));
    }
  }
  if (ruleIds.length) {
    ops.push(ActionRule.updateMany(
      { _id: { $in: ruleIds }, trailId: null },
      { $set: { enabled: false, control: 'off', migratedToTrailId: trailId } },
    ));
  }
  if (ops.length) await Promise.all(ops);
}

async function getLegacySummary() {
  const allMappedEvents = [...new Set(Object.values(LEGACY_EVENTS_BY_TRIGGER).flat())];
  const [migratedPolicies, dbTemplateEvents, legacyRules] = await Promise.all([
    EmailPolicy.find({ event: { $in: allMappedEvents }, migratedToTrailId: { $ne: null } }).select('event').lean(),
    EmailTemplate.distinct('event', { event: { $in: allMappedEvents }, migratedToTrailId: null }),
    ActionRule.find({ trailId: null, migratedToTrailId: null, kind: 'reminder' }).select('action actions steps.text').lean(),
  ]);

  const migratedSet = new Set(migratedPolicies.map(p => p.event));
  const dbEventSet = new Set(dbTemplateEvents);
  const triggersWithLegacy = new Set();

  for (const [triggerKey, events] of Object.entries(LEGACY_EVENTS_BY_TRIGGER)) {
    const hasTemplate = events.some(ev => !migratedSet.has(ev) && (dbEventSet.has(ev) || Boolean(definitions[ev]?.text)));
    if (hasTemplate) triggersWithLegacy.add(triggerKey);
  }

  for (const rule of legacyRules) {
    const hasStep = Array.isArray(rule.steps) && rule.steps.some(st => Boolean(String(st?.text || '').trim()));
    if (!hasStep) continue;
    const keys = Array.isArray(rule.actions) && rule.actions.length ? rule.actions : (rule.action ? [rule.action] : []);
    for (const k of keys) if (k) triggersWithLegacy.add(k);
  }

  return [...triggersWithLegacy];
}

module.exports = {
  LEGACY_EVENTS_BY_TRIGGER,
  getLegacyForTriggers,
  getLegacySummary,
  stampMigratedLegacy,
};
