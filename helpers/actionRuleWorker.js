const { randomUUID } = require('node:crypto');
const Event = require('../models/communicationActionEventModel');
const Rule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const Invoice = require('../models/invoiceModel');
const Order = require('../models/orderProductModel');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { ACTIONS, enabled } = require('./actionEvents');
const { SELECTABLE_LEAD_STATUSES, WON } = require('./leadStatuses');
const { teamContacts, teamRecipients } = require('./teamContacts');

// Action rules (Reminder.md §4). Every minute (index.js, ACTION_RULES_ENABLED):
// 1. each new action event stops matching scheduled runs, then plans runs for its enabled rules;
// 2. due runs are checked again (is the reason still true?) and sent.
const DAY = 86400000;
const HOUR = 3600000;
const LOCK_MS = 120000;
const OPEN = ['unpaid', 'partially_paid', 'overdue'];
const BILLED = ['project', 'plan_renewal'];
// Fail-closed SSOT filter: only new Automated Message System trails (`trailId != null`) run unless legacy mode is explicitly opted in.
const activeRuleFilter = () => (process.env.ACTION_RULES_LEGACY_ENABLED === 'true' ? {} : { trailId: { $ne: null } });

async function orderFullyPaid(orderId) {
  if (!orderId) return false;
  return !await Invoice.exists({ orderId, invoiceType: { $in: BILLED }, status: { $in: OPEN } });
}

function packageSlugOf(order) {
  return String(
    order?.salesPackage?.packageSlug || order?.salesPackage?.slug || order?.salesPackage?.packageId ||
    order?.salesPackage?.package?.id || order?.projectSnapshot?.salesAgreement?.package?.id ||
    order?.servicePlanSnapshot?.packageSlug || '',
  ).trim();
}

async function orderHasUpload(order) {
  if (!order?._id) return false;
  const UpdateRequest = require('../models/updateRequestModel');
  const cycleStart = order.serviceCurrentCycleStartDate || order.createdAt || new Date(0);
  return !!(await UpdateRequest.exists({
    $or: [
      { updatePlanId: order._id, ...(order.isServicePlan ? { createdAt: { $gte: cycleStart } } : {}) },
      ...(order.userId ? [{ userId: order.userId, createdAt: { $gte: cycleStart } }] : []),
    ],
  }));
}

function orderRemainingLimit(order) {
  if (!order) return null;
  if (typeof order.currentMonthUpdatesRemaining === 'number' && Number.isFinite(order.currentMonthUpdatesRemaining)) {
    return order.currentMonthUpdatesRemaining;
  }
  if (order.demoMode?.active && typeof order.demoMode.uploadsRemaining === 'number') {
    return order.demoMode.uploadsRemaining;
  }
  return null;
}

const ORDER_CONTEXT_SELECT = 'userId orderItems servicePlanSnapshot salesPackage projectSnapshot orderVisibility status servicePlanStatus serviceAutoRenewalStoppedAt serviceNextBillingDate serviceBillingCycleMonths serviceCurrentCycleStartDate isServicePlan createdAt currentMonthUpdatesRemaining demoMode projectProgress isPartialPayment currentInstallment installments paymentPolicy expectedCompletionDate';

async function orderHasPendingApproval(order) {
  if (!order?._id) return false;
  if (Array.isArray(order.installments) && order.installments.some(inst => inst?.paymentStatus === 'pending-approval')) {
    return true;
  }
  const Transaction = require('../models/transactionModel');
  return !!(await Transaction.exists({ orderId: order._id, status: 'pending', paymentStatus: 'pending-approval' }));
}

async function resolveEventContext(event, { needsPendingCheck = true, needsUploadCheck = true } = {}) {
  const entityType = ACTIONS[event.action]?.entityType || 'none';
  const originSurface = String(event.details?.originSurface || '').trim();
  if (entityType === 'none' || entityType === 'package_start' || entityType === 'final_message') {
    let linkedOrder = null;
    if (entityType === 'none' && event.orderId) {
      linkedOrder = await Order.findById(event.orderId).select(ORDER_CONTEXT_SELECT).lean();
    }
    return {
      invoice: null, order: linkedOrder, isPaid: false, isPendingApproval: false, isInstallmentDue: false,
      progress: Number(linkedOrder?.projectProgress ?? event.details?.progress ?? 0),
      remainingLimit: orderRemainingLimit(linkedOrder) ?? (event.details?.remainingLimit ?? null),
      isMonthly: !!linkedOrder?.salesPackage || !!linkedOrder?.isServicePlan,
      isOfferPayment: !!linkedOrder?.paymentPolicy,
      offerOffsets: Array.isArray(linkedOrder?.paymentPolicy?.reminderOffsets) ? linkedOrder.paymentPolicy.reminderOffsets : [],
      packageSlug: packageSlugOf(linkedOrder),
      originSurface, dueDate: event.details?.dueDate || null, expiryDate: linkedOrder?.serviceNextBillingDate || null, deadlineDate: linkedOrder?.expectedCompletionDate || null,
    };
  }
  if (entityType === 'reservation') {
    const Reservation = require('../models/offerReservationModel');
    const row = await Reservation.findById(event.entityId).select('expiresAt extendedUntil').lean();
    const dueDate = row ? (row.extendedUntil || row.expiresAt) : (event.details?.dueDate || null);
    return {
      invoice: null, order: null, isPaid: false, isPendingApproval: false, isInstallmentDue: false,
      progress: 0, remainingLimit: null,
      isMonthly: false, isOfferPayment: false, offerOffsets: [], packageSlug: '',
      originSurface, dueDate, expiryDate: dueDate, deadlineDate: dueDate,
    };
  }
  let invoice = null;
  let order = null;
  if (entityType === 'invoice') {
    invoice = await Invoice.findById(event.entityId).select('orderId userId invoiceType status amount amountPaid dueDate installmentNumber createdAt').lean();
    order = invoice?.orderId ? await Order.findById(invoice.orderId).select(ORDER_CONTEXT_SELECT).lean() : null;
  } else {
    order = await Order.findById(event.entityId).select(ORDER_CONTEXT_SELECT).lean();
    if (order) {
      invoice = await Invoice.findOne({ orderId: order._id, invoiceType: { $in: BILLED }, status: { $ne: 'cancelled' } })
        .select('orderId userId invoiceType status amount amountPaid dueDate installmentNumber createdAt')
        .sort({ createdAt: -1 }).lean();
    }
  }
  const isPaid = invoice ? !OPEN.includes(invoice.status) : await orderFullyPaid(order?._id);
  const isPendingApproval = (!isPaid && needsPendingCheck && order) ? await orderHasPendingApproval(order) : false;
  const dueInst = order ? require('./projectDuePayment').dueInstallment(order) : null;
  const isInstallmentDue = !!dueInst || !!(invoice?.installmentNumber && OPEN.includes(invoice.status));
  const progress = Number(order?.projectProgress ?? event.details?.progress ?? 0);
  const remainingLimit = orderRemainingLimit(order) ?? (event.details?.remainingLimit ?? null);
  const isMonthly = invoice?.invoiceType === 'plan_renewal' || !!order?.salesPackage || !!order?.isServicePlan;
  const isOfferPayment = !!order?.paymentPolicy;
  const offerOffsets = Array.isArray(order?.paymentPolicy?.reminderOffsets) ? order.paymentPolicy.reminderOffsets : [];
  const packageSlug = packageSlugOf(order);
  const hasUploaded = (needsUploadCheck && order) ? await orderHasUpload(order) : false;
  const dueDate = invoice?.dueDate || dueInst?.dueDate || order?.serviceNextBillingDate || event.details?.dueDate || null;
  const expiryDate = order?.serviceNextBillingDate || dueDate;
  const deadlineDate = order?.expectedCompletionDate || dueDate;
  return { invoice, order, isPaid, isPendingApproval, isInstallmentDue, progress, remainingLimit, isMonthly, isOfferPayment, offerOffsets, packageSlug, hasUploaded, originSurface, dueDate, expiryDate, deadlineDate };
}

function ruleMatchesContext(rule, ctx) {
  if (Array.isArray(rule.originFilter) && rule.originFilter.length) {
    const effectiveOrigin = ctx.originSurface || 'System';
    if (!rule.originFilter.includes(effectiveOrigin)) return false;
  }
  if (rule.condition === 'unpaid' && (ctx.isPaid || ctx.isPendingApproval)) return false;
  if (rule.condition === 'pending_approval' && !ctx.isPendingApproval) return false;
  if (rule.condition === 'paid' && !ctx.isPaid) return false;
  if (rule.condition === 'installment_due' && (!ctx.isInstallmentDue || ctx.isPendingApproval)) return false;
  if (rule.condition === 'upload_pending' && ctx.hasUploaded) return false;
  if (Number(rule.minProgress || 0) > 0 && Number(ctx.progress || 0) < Number(rule.minProgress)) return false;
  if (rule.minRemainingLimit !== null && rule.minRemainingLimit !== undefined) {
    if (ctx.remainingLimit === null || ctx.remainingLimit === undefined || ctx.remainingLimit < Number(rule.minRemainingLimit)) return false;
  }
  if (rule.maxRemainingLimit !== null && rule.maxRemainingLimit !== undefined) {
    if (ctx.remainingLimit === null || ctx.remainingLimit === undefined || ctx.remainingLimit > Number(rule.maxRemainingLimit)) return false;
  }
  const scopeKind = rule.scope?.kind || 'all';
  if (scopeKind === 'offer_payment' && !ctx.isOfferPayment) return false;
  if (scopeKind === 'monthly' && !ctx.isMonthly) return false;
  if (scopeKind === 'one_time' && ctx.isMonthly) return false;
  if (scopeKind === 'package' && (!rule.scope?.packageSlug || ctx.packageSlug !== rule.scope.packageSlug)) return false;
  if (scopeKind === 'include') {
    const inc = Array.isArray(rule.scope?.includedPackages) ? rule.scope.includedPackages : [];
    if (!inc.length || !ctx.packageSlug || !inc.includes(ctx.packageSlug)) return false;
  }
  if (scopeKind === 'exclude') {
    const exc = Array.isArray(rule.scope?.excludedPackages) ? rule.scope.excludedPackages : [];
    if (ctx.packageSlug && exc.includes(ctx.packageSlug)) return false;
  }
  return true;
}

function resolveBaseDate(rule, occurredAt, dueDate, ctx) {
  const mode = rule.baseDate || 'due_date';
  if (mode === 'trigger_date') return occurredAt;
  if (mode === 'expiry_date') return ctx?.expiryDate || dueDate;
  if (mode === 'deadline_date') return ctx?.deadlineDate || dueDate;
  return dueDate;
}

function stepDueAt(step, occurredAt, dueDate) {
  const offsetMs = step.unit === 'hours'
    ? (step.hours ?? 0) * HOUR
    : (step.days !== undefined ? step.days : (step.afterDays || 0)) * DAY;
  const ref = step.timingRef || 'after_action';
  if (ref === 'after_action') return new Date(+new Date(occurredAt) + offsetMs);
  if (!dueDate) return null;
  const base = +new Date(dueDate);
  if (ref === 'before_due') return new Date(base - offsetMs);
  if (ref === 'on_due') return new Date(base);
  if (ref === 'after_due') return new Date(base + offsetMs);
  return null;
}

// Steps first, then repeats after the last step.
function planRuns(rule, event, dueDate = event.details?.dueDate || null, ctx = null) {
  const sends = [];
  const effectiveBase = resolveBaseDate(rule, event.occurredAt, dueDate, ctx);
  if (rule.scope?.kind === 'offer_payment' && ctx?.offerOffsets?.length && effectiveBase && rule.steps?.length) {
    const baseStep = rule.steps[0];
    const baseMs = +new Date(effectiveBase);
    const sortedOffsets = [...ctx.offerOffsets].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    for (const offsetDays of sortedOffsets) {
      sends.push({ ...baseStep, dueAt: new Date(baseMs + offsetDays * DAY) });
    }
  } else {
    for (const step of rule.steps) {
      const dueAt = stepDueAt(step, event.occurredAt, effectiveBase);
      if (dueAt) sends.push({ ...step, dueAt });
    }
  }
  if (!sends.length) return [];
  const last = sends[sends.length - 1];
  const repeatMode = rule.repeat?.mode === 'permanent'
    ? 'permanent'
    : ((rule.repeat?.mode === 'limited' || (rule.repeat?.times || 0) > 0) ? 'limited' : 'off');
  const everyDays = Math.max(1, Number(rule.repeat?.everyDays || 1));
  const perDay = Math.max(1, Number(rule.repeat?.perDay || 1));
  if (repeatMode === 'permanent') {
    // Rolling permanent repeat: schedule only the first repeat cycle; dispatchRun schedules the next one on send.
    const dayBase = +last.dueAt + everyDays * DAY;
    for (let slot = 0; slot < perDay; slot++) {
      const offsetMs = Math.round((slot * DAY) / perDay);
      sends.push({ ...last, dueAt: new Date(dayBase + offsetMs) });
    }
  } else if (repeatMode === 'limited') {
    const repeatTimes = Number(rule.repeat?.times || 0) || Math.min(60, Math.max(1, Math.floor(Number(rule.repeat?.forDays || 0) / everyDays)));
    for (let n = 1; n <= repeatTimes; n++) {
      const dayBase = +last.dueAt + n * everyDays * DAY;
      for (let slot = 0; slot < perDay; slot++) {
        const offsetMs = Math.round((slot * DAY) / perDay);
        sends.push({ ...last, dueAt: new Date(dayBase + offsetMs) });
      }
    }
  }
  // Entity-level dedupe for multi-action trail rules so overlapping events never double-send.
  const isMultiAction = Array.isArray(rule.actions) && rule.actions.length > 1;
  const occurrenceKey = (rule.trailId && isMultiAction)
    ? `trail:${String(rule.trailId)}:entity:${String(event.orderId || event.entityId)}`
    : event.key;
  return sends.map((send, step) => ({
    ruleId: rule._id,
    ruleRevision: rule.revision,
    source: 'action',
    action: event.action,
    audience: rule.audience || 'customer',
    occurrenceKey,
    step,
    entityId: event.entityId,
    clientId: event.clientId || null,
    leadId: event.leadId || null,
    dueAt: send.dueAt,
    channel: send.channel,
    subject: send.subject || ACTIONS[event.action].label,
    text: send.text,
    stopOn: rule.stopOn,
    doAlso: Array.isArray(rule.doAlso) ? rule.doAlso : [],
    matchKeys: event.matchKeys,
    status: 'scheduled',
  }));
}

const DIRECT_TEMPLATE_MIGRATED = new Set([
  'template:lead.finalMessage',
  'template:website.subscription.confirm',
  'template:website.subscription.manage',
]);

async function handleEvent(event) {
  let keys = event.matchKeys || [];
  if (event.action === 'payment.received' && await orderFullyPaid(event.orderId)) keys = [...keys, `order:${event.orderId}`];
  if (keys.length) {
    const stopFilter = { source: 'action', status: { $in: ['scheduled', 'queued'] }, stopOn: event.action, matchKeys: { $in: keys } };
    const matchingRuns = await Run.find(stopFilter).select('_id status').lean();
    if (matchingRuns.length) {
      const stopReason = `Stopped: ${ACTIONS[event.action].label}.`;
      const scheduledIds = matchingRuns.filter(r => r.status === 'scheduled').map(r => r._id);
      if (scheduledIds.length) {
        await Run.updateMany({ _id: { $in: scheduledIds }, status: 'scheduled' }, { $set: { status: 'cancelled', reason: stopReason } });
      }
      // Also cancel any pending WhatsApp Queue rows belonging to stopped runs.
      const allStoppedIds = matchingRuns.map(r => r._id);
      const { Queue, finishedExpiry } = require('../whatsapp/src/models.js');
      await Queue.updateMany(
        { reminderRunId: { $in: allStoppedIds }, status: 'pending' },
        { $set: { status: 'cancelled', lastError: stopReason, expiresAt: finishedExpiry(new Date()) } },
      );
    }
  }
  const rules = await Rule.find({
    ...activeRuleFilter(),
    $or: [{ action: event.action }, { actions: event.action }],
    enabled: true,
    control: { $in: ['auto', 'review'] },
    activatedAt: { $lte: event.occurredAt },
  }).lean();
  if (!rules.length) return;
  const needsPendingCheck = rules.some(r => ['unpaid', 'pending_approval', 'installment_due'].includes(r.condition));
  const needsUploadCheck = rules.some(r => r.condition === 'upload_pending');
  const ctx = await resolveEventContext(event, { needsPendingCheck, needsUploadCheck });
  const syncReviewed = Array.isArray(event.details?.syncReviewedTemplates) ? event.details.syncReviewedTemplates : [];
  const syncReviewedTrails = Array.isArray(event.details?.syncReviewedTrails) ? event.details.syncReviewedTrails : [];
  for (const rule of rules) {
    if (DIRECT_TEMPLATE_MIGRATED.has(rule.migratedFrom)) continue;
    if (rule.migratedFrom && syncReviewed.includes(rule.migratedFrom)) continue;
    if (rule.trailId && rule.kind === 'template') {
      const trailKey = `${String(rule.trailId)}:${rule.audience || 'customer'}`;
      if (syncReviewedTrails.includes(trailKey) || syncReviewedTrails.includes(String(rule.trailId))) continue;
    }
    if (!event.clientId && !event.leadId && rule.audience !== 'admin') continue;
    if (!ruleMatchesContext(rule, ctx)) continue;
    for (const run of planRuns(rule, event, ctx.dueDate, ctx)) {
      const id = { ruleId: run.ruleId, ruleRevision: run.ruleRevision, occurrenceKey: run.occurrenceKey, step: run.step };
      await Run.updateOne(id, { $setOnInsert: run }, { upsert: true });
    }
  }
}

async function processEvents(limit = 200) {
  let handled = 0;
  for (; handled < limit; handled++) {
    const now = new Date();
    const event = await Event.findOneAndUpdate({ $or: [{ status: 'new' }, { status: 'processing', lockUntil: { $lte: now } }] },
      { $set: { status: 'processing', lockUntil: new Date(+now + LOCK_MS) }, $inc: { attempts: 1 } }, { sort: { occurredAt: 1 }, new: true }).lean();
    if (!event) break;
    try {
      await handleEvent(event);
      await Event.updateOne({ _id: event._id }, { $set: { status: 'done', processedAt: new Date(), expiresAt: new Date(Date.now() + DAY) }, $unset: { lockUntil: 1, error: 1 } });
    } catch (error) {
      const failed = event.attempts >= 5;
      await Event.updateOne({ _id: event._id }, { $set: { status: failed ? 'failed' : 'new', error: String(error.message).slice(0, 300) }, $unset: { lockUntil: 1 } });
    }
  }
  return handled;
}

// The check right before sending: the reason for the message must still be true, even if the
// stop action came through a path that records no event.
async function stillValid(run) {
  const rule = await Rule.findOne({ _id: run.ruleId, ...activeRuleFilter(), enabled: true, control: { $in: ['auto', 'review'] } })
    .select('_id trailId kind condition minProgress minRemainingLimit maxRemainingLimit control scope repeat').lean();
  if (!rule) return { ok: false, reason: 'Rule is off.' };
  let client = null;
  let lead = run.leadId ? await Lead.findById(run.leadId).select('name email phone status convertedToUserId deletedAt').lean() : null;
  if (run.clientId) {
    client = await User.findById(run.clientId).select('name email phone isActive isGuest deletedAt').lean();
    if (!client || client.isActive === false || client.isGuest || client.deletedAt) return { ok: false, reason: 'Customer is unavailable.' };
  } else if (lead && !lead.deletedAt && !lead.convertedToUserId) {
    if (run.action === 'broadcast.sent') {
      const blocks = await require('./leadContactBlock').contactBlocks();
      const { normalizePhone } = require('./whatsappQueue');
      const phoneKey = normalizePhone(lead.phone || '');
      const emailKey = String(lead.email || '').trim().toLowerCase();
      if ((phoneKey && blocks.phones?.has(phoneKey)) || (emailKey && blocks.emails?.has(emailKey))) {
        return { ok: false, reason: 'Contact is blocked.' };
      }
    }
    client = { name: lead.name || 'Customer', email: lead.email || '', phone: lead.phone || '' };
  } else if (run.audience === 'admin') {
    client = { name: 'System / Admin', email: '', phone: '' };
  } else {
    return { ok: false, reason: 'Customer or lead is unavailable.' };
  }
  const waitsForPayment = (run.stopOn || []).includes('payment.received') || rule.condition === 'unpaid' || rule.condition === 'installment_due';
  const entityType = ACTIONS[run.action]?.entityType || 'none';
  let invoice = null, order = null;
  if (entityType === 'none') {
    // Non-order / non-invoice actions need no invoice or order lookup.
  } else if (run.action === 'reservation.start_requested') {
    const Reservation = require('../models/offerReservationModel');
    const row = await Reservation.findById(run.entityId).select('projectId confirmedAt startRequestedAt startRequests teamRemindersPaused').lean();
    const lastReq = row?.startRequests?.at(-1);
    if (!row || row.projectId || row.confirmedAt || !row.startRequestedAt || row.teamRemindersPaused || lastReq?.ended) {
      return { ok: false, reason: 'Reservation start request is closed or paused.' };
    }
  } else if (entityType === 'package_start') {
    const StartRequest = require('../models/packageStartRequestModel');
    const row = await StartRequest.findById(run.entityId).select('closedAt remindersPaused').lean();
    if (!row || row.closedAt || row.remindersPaused) {
      return { ok: false, reason: 'Package start request is closed or paused.' };
    }
  } else if (entityType === 'reservation') {
    const Reservation = require('../models/offerReservationModel');
    const row = await Reservation.findById(run.entityId).select('projectId confirmedAt startRequestedAt remindersPaused expiresAt extendedUntil').lean();
    const deadline = row ? new Date(row.extendedUntil || row.expiresAt) : null;
    if (!row || row.projectId || row.confirmedAt || row.startRequestedAt || row.remindersPaused || !deadline || deadline <= new Date()) {
      return { ok: false, reason: 'Reservation countdown is no longer active.' };
    }
  } else if (entityType === 'final_message') {
    const { FinalMessage } = require('../whatsapp/src/models.js');
    const row = await FinalMessage.findById(run.entityId).select('status').lean();
    if (!row || row.status !== 'waiting') {
      return { ok: false, reason: 'Final message is no longer waiting.' };
    }
  } else if (entityType === 'invoice') {
    if (String(run.occurrenceKey || '').startsWith('projected:')) {
      order = await Order.findById(run.entityId).select('orderItems servicePlanSnapshot salesPackage orderVisibility status servicePlanStatus serviceAutoRenewalStoppedAt serviceNextBillingDate serviceBillingCycleMonths serviceCurrentCycleNumber currentMonthUpdatesRemaining demoMode projectProgress isPartialPayment currentInstallment installments').lean();
      const { isFinalCycle } = require('./serviceBillingSchedule');
      if (!order || order.orderVisibility === 'cancelled' || order.status === 'cancelled' || order.servicePlanStatus !== 'active' || order.serviceAutoRenewalStoppedAt || isFinalCycle(order, order.serviceCurrentCycleNumber)) {
        return { ok: false, reason: 'Renewal is stopped or paused.' };
      }
      invoice = await Invoice.findOne({ orderId: order._id, invoiceType: 'plan_renewal', status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).lean();
      if (invoice && waitsForPayment && !OPEN.includes(invoice.status)) return { ok: false, reason: 'Invoice is already paid.' };
    } else {
      invoice = await Invoice.findById(run.entityId)
        .select('orderId userId invoiceType status amount amountPaid dueDate installmentNumber offerRemindersPaused').lean();
      if (!invoice || invoice.status === 'cancelled') return { ok: false, reason: 'Invoice is unavailable.' };
      if (rule.scope?.kind === 'offer_payment' && invoice.offerRemindersPaused) return { ok: false, reason: 'Offer reminders are paused for this invoice.' };
      if (waitsForPayment && !OPEN.includes(invoice.status)) return { ok: false, reason: 'Invoice is already paid.' };
      order = invoice.orderId ? await Order.findById(invoice.orderId).select('userId orderItems servicePlanSnapshot salesPackage projectSnapshot orderVisibility serviceNextBillingDate serviceBillingCycleMonths serviceCurrentCycleStartDate isServicePlan createdAt currentMonthUpdatesRemaining demoMode projectProgress isPartialPayment currentInstallment installments').lean() : null;
    }
  } else {
    order = await Order.findById(run.entityId).select('userId orderItems servicePlanSnapshot salesPackage projectSnapshot orderVisibility status servicePlanStatus serviceNextBillingDate serviceBillingCycleMonths serviceCurrentCycleStartDate isServicePlan createdAt currentMonthUpdatesRemaining demoMode projectProgress isPartialPayment currentInstallment installments').lean();
    if (!order || order.orderVisibility === 'cancelled' || order.status === 'cancelled') return { ok: false, reason: 'Project or plan is unavailable.' };
    if (rule.condition === 'installment_due') {
      const dueInst = require('./projectDuePayment').dueInstallment(order);
      if (!dueInst) return { ok: false, reason: 'Installment is already paid or not due.' };
    } else if (waitsForPayment && await orderFullyPaid(order._id)) {
      return { ok: false, reason: 'Payment is complete.' };
    }
    invoice = await Invoice.findOne({ orderId: order._id, invoiceType: { $in: BILLED }, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).lean();
  }
  if (rule.condition === 'unpaid' && order && await orderHasPendingApproval(order)) {
    return { ok: false, reason: 'Payment already submitted by client (pending admin approval).' };
  }
  if (rule.condition === 'pending_approval' && (!order || !(await orderHasPendingApproval(order)))) {
    return { ok: false, reason: 'No client-submitted payment is waiting for admin approval.' };
  }
  if (rule.condition === 'upload_pending' && order && await orderHasUpload(order)) {
    return { ok: false, reason: 'Customer already uploaded data.' };
  }
  if (Number(rule.minProgress || 0) > 0 && order && Number(order.projectProgress || 0) < Number(rule.minProgress)) {
    return { ok: false, reason: 'Project progress is below rule threshold.' };
  }
  if (rule.minRemainingLimit !== null && rule.minRemainingLimit !== undefined && order) {
    const rem = orderRemainingLimit(order);
    if (rem === null || rem < Number(rule.minRemainingLimit)) {
      return { ok: false, reason: 'Remaining upload limit is below rule threshold.' };
    }
  }
  if (rule.maxRemainingLimit !== null && rule.maxRemainingLimit !== undefined && order) {
    const rem = orderRemainingLimit(order);
    if (rem === null || rem > Number(rule.maxRemainingLimit)) {
      return { ok: false, reason: 'Remaining upload limit is above rule threshold.' };
    }
  }
  if (run.audience === 'admin') {
    const contacts = await teamContacts();
    if (!contacts.length) return { ok: false, reason: 'No admin contact configured.' };
    return { ok: true, trailId: rule.trailId || null, ruleKind: rule.kind, control: rule.control, repeat: rule.repeat, client, lead, invoice, order, contacts };
  }
  return { ok: true, trailId: rule.trailId || null, ruleKind: rule.kind, control: rule.control, repeat: rule.repeat, client, lead, invoice, order };
}

// Same check for the email provider and WhatsApp handoff (communicationReminderEligibility.js),
// plus: the destination must still match the customer or configured admin contacts.
async function actionEligibility(run, target = {}) {
  const check = await stillValid(run);
  if (!check.ok) return { allowed: false, reason: check.reason };
  const digits = value => String(value || '').replace(/\D/g, '');
  if (run.audience === 'admin') {
    const contacts = check.contacts || [];
    const adminEmails = new Set(contacts.map(c => String(c.email || '').toLowerCase()).filter(Boolean));
    const adminPhones = new Set(contacts.flatMap(c => c.numbers || []).map(n => digits(n).slice(-10)).filter(Boolean));
    if (target.phone) {
      const target10 = digits(target.phone).slice(-10);
      if (!adminPhones.has(target10)) {
        // Admins with no saved WhatsApp numbers in Settings keep their account phone (teamContacts.js).
        const { savedPhoneFor } = require('./whatsappQueue');
        for (const c of contacts) {
          if (c.numbers?.length || !c.email) continue;
          const fallback = digits(await savedPhoneFor(c.email)).slice(-10);
          if (fallback) adminPhones.add(fallback);
        }
      }
      if (!adminPhones.has(target10)) return { allowed: false, reason: 'Admin WhatsApp destination changed.' };
    }
    if (target.emails?.length && target.emails.some(e => !adminEmails.has(String(e).toLowerCase()))) return { allowed: false, reason: 'Admin email destination changed.' };
    return { allowed: true, candidate: check };
  }
  if (target.phone && digits(target.phone).slice(-10) !== digits(check.client.phone).slice(-10)) return { allowed: false, reason: 'WhatsApp destination changed.' };
  if (target.emails?.length && (target.emails.length !== 1 || String(target.emails[0]).toLowerCase() !== String(check.client.email || '').toLowerCase())) return { allowed: false, reason: 'Email destination changed.' };
  return { allowed: true, candidate: check };
}

const day = value => (value ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : '');
function safeUrl(baseUrl, path) {
  try {
    const base = new URL(baseUrl);
    return ['http:', 'https:'].includes(base.protocol) ? new URL(path, base).toString() : '';
  } catch {
    return '';
  }
}
const portalLink = path => safeUrl(process.env.FORNTEND_URL, path);
const websiteLink = path => safeUrl(process.env.PORTFOLIO_WEBSITE_URL, path);

const KNOWN_PLACEHOLDERS = new Set([
  'name', 'amount', 'dueDate', 'invoiceLink', 'projectLink', 'packageLink', 'planLink', 'portalLink',
  'project', 'planName', 'package', 'duration', 'email', 'phone', 'progress', 'remainingLimit',
]);
function normalizePlaceholders(text) {
  return String(text || '').replace(/(?<!\{)\{(\w+)\}(?!\})/g, (m, key) => (KNOWN_PLACEHOLDERS.has(key) ? `{{${key}}}` : m));
}

async function executeDoAlso(run, check, values, render) {
  const steps = Array.isArray(run.doAlso) ? run.doAlso : [];
  if (!steps.length || run.step !== 0) return;
  try {
    let lead = check.lead && !check.lead.deletedAt ? check.lead : null;
    if (!lead && run.clientId) {
      lead = await Lead.findOne({ convertedToUserId: run.clientId, deletedAt: null }).select('_id status convertedToUserId').lean();
    }
    let leadStatus = lead?.status || 'Contacted';
    const now = new Date();
    for (const item of steps) {
      if (item.type === 'change_lead_stage') {
        if (lead && !lead.convertedToUserId && leadStatus !== WON && SELECTABLE_LEAD_STATUSES.includes(item.stage)) {
          await Lead.updateOne(
            { _id: lead._id },
            { $set: { status: item.stage }, $push: { followUps: { note: 'Stage updated automatically by Action rule.', badge: item.stage, date: now, createdAt: now } } },
          );
          leadStatus = item.stage;
        }
      } else if (item.type === 'add_lead_note') {
        const note = render(String(item.note || ''), values, {}, { plain: true }).trim();
        if (lead && note) {
          await Lead.updateOne(
            { _id: lead._id },
            { $push: { followUps: { note, badge: leadStatus, date: now, createdAt: now } } },
          );
        }
      } else if (item.type === 'stop_reminders') {
        const targets = [
          ...(run.clientId ? [{ clientId: run.clientId }] : []),
          ...(run.leadId ? [{ leadId: run.leadId }] : []),
        ];
        if (targets.length) {
          await Run.updateMany(
            { _id: { $ne: run._id }, source: 'action', status: 'scheduled', $or: targets },
            { $set: { status: 'cancelled', reason: 'Stopped automatically by Action rule.' } },
          );
        }
      }
    }
  } catch (error) {
    console.error('[action doAlso]', error.message);
  }
}

async function dispatchRun(runId, now = new Date()) {
  const owner = randomUUID();
  const run = await Run.findOneAndUpdate({ _id: runId, source: 'action', dueAt: { $lte: now }, $or: [{ status: 'scheduled' }, { status: 'preparing', lockUntil: { $lte: now } }] },
    { $set: { status: 'preparing', lockOwner: owner, lockUntil: new Date(Date.now() + LOCK_MS) } }, { new: true }).lean();
  if (!run) return 'not-due';
  const finish = (status, fields = {}) => Run.updateOne({ _id: run._id, status: 'preparing', lockOwner: owner }, { $set: { status, ...fields }, $unset: { lockOwner: 1, lockUntil: 1 } });
  try {
    const check = await stillValid(run);
    if (!check.ok) { await finish('cancelled', { reason: check.reason }); return 'cancelled'; }
    const { client, invoice, order, contacts } = check;
    const planName = order?.salesPackage?.packageName || order?.salesPackage?.name || order?.servicePlanSnapshot?.serviceName || order?.orderItems?.[0]?.name || '';
    const packageSlug = String(
      order?.salesPackage?.packageSlug || order?.salesPackage?.slug || order?.salesPackage?.packageId ||
      order?.servicePlanSnapshot?.packageSlug || '',
    ).trim();
    const months = order?.salesPackage?.months || order?.serviceBillingCycleMonths || order?.servicePlanSnapshot?.selectedBillingCycleMonths;
    const duration = months ? `${months} month${months > 1 ? 's' : ''}` : '';
    const dueInst = order ? require('./projectDuePayment').dueInstallment(order) : null;
    const invoiceAmount = invoice
      ? (run.action === 'payment.received' ? Number(invoice.amount || 0) : Number(invoice.amount - (invoice.amountPaid || 0)))
      : (dueInst ? Number(dueInst.amount || 0) : 0);
    const remLimit = orderRemainingLimit(order);
    const values = {
      name: client.name || 'Customer',
      email: client.email || '',
      phone: client.phone || '',
      project: order?.orderItems?.[0]?.name || planName,
      planName,
      package: planName || 'Package',
      duration,
      progress: order ? `${Number(order.projectProgress || 0)}%` : '',
      remainingLimit: remLimit !== null ? String(remLimit) : '',
      amount: (invoice || dueInst) ? `₹${invoiceAmount.toLocaleString('en-IN')}` : '',
      dueDate: day(invoice?.dueDate || dueInst?.dueDate || order?.serviceNextBillingDate),
      invoiceLink: invoice ? portalLink(`/invoice-detail/${invoice._id}`) : (order?._id ? portalLink(`/project-details/${order._id}`) : ''),
      projectLink: order?._id ? portalLink(`/project-details/${order._id}`) : '',
      planLink: order?._id ? portalLink(`/plan-details/${order._id}`) : '',
      packageLink: packageSlug ? websiteLink(`/package/${encodeURIComponent(packageSlug)}`) : '',
      portalLink: portalLink('/'),
    };
    const key = `action-rule:${run._id}`;
    const { render } = require('./emailMarkup');
    const isAdmin = run.audience === 'admin';
    const to = isAdmin ? (contacts || []).map(c => c.email).filter(Boolean) : (client.email ? [client.email] : []);
    const phone = isAdmin ? ((contacts || []).flatMap(c => c.numbers)[0] || '') : client.phone;
    const mail = {
      reviewed: true,
      fromActionRule: true,
      to,
      phone,
      subject: render(normalizePlaceholders(run.subject), values, {}, { plain: true }),
      text: normalizePlaceholders(run.text),
      values,
      reminderRunId: run._id,
      ...(check.trailId && check.ruleKind === 'template' ? { trailId: check.trailId, trailAudience: isAdmin ? 'admin' : 'client' } : {}),
    };
    const result = await require('./emailController').sendSystemMail('reminder.automated', mail, key, '/action-rules', {
      channel: run.channel,
      reviewOnly: check.control === 'review',
    });
    if (result === 'staged-review') {
      const { EmailDraft } = require('../models/emailControlModel');
      const draft = await EmailDraft.findOne({ dedupeKey: key }).select('_id').lean();
      await finish('queued', { ...(draft?._id ? { emailDraftId: draft._id } : {}), reason: 'Waiting for admin review.' });
      return 'queued';
    }
    if (result === 'sent') {
      await executeDoAlso(run, check, values, (tmpl, vals, blks, opts) => render(normalizePlaceholders(tmpl), vals, blks, opts));
      const { EmailDraft } = require('../models/emailControlModel');
      const draft = await EmailDraft.findOne({ dedupeKey: key }).select('_id delivery sentAt').lean();
      const queued = draft?.delivery?.whatsappStatus === 'queued';
      await finish(queued ? 'queued' : 'sent', { ...(draft?._id ? { emailDraftId: draft._id } : {}), ...(!queued ? { sentAt: draft?.sentAt || new Date() } : {}) });
      // Rolling Permanent Repeat: schedule the next run only after this one succeeds, if no later step is already scheduled.
      if (check.repeat?.mode === 'permanent') {
        const hasNext = await Run.exists({
          ruleId: run.ruleId, ruleRevision: run.ruleRevision, occurrenceKey: run.occurrenceKey,
          step: { $gt: run.step }, status: 'scheduled',
        });
        if (!hasNext) {
          const everyDays = Math.max(1, Number(check.repeat.everyDays || 1));
          const perDay = Math.max(1, Number(check.repeat.perDay || 1));
          const intervalMs = perDay > 1 ? Math.round(DAY / perDay) : everyDays * DAY;
          const nextStep = run.step + 1;
          const nextDue = new Date(Math.max(+new Date(run.dueAt), +now) + intervalMs);
          await Run.updateOne(
            { ruleId: run.ruleId, ruleRevision: run.ruleRevision, occurrenceKey: run.occurrenceKey, step: nextStep },
            {
              $setOnInsert: {
                ruleId: run.ruleId, ruleRevision: run.ruleRevision, source: 'action', action: run.action,
                audience: run.audience, occurrenceKey: run.occurrenceKey, step: nextStep, entityId: run.entityId,
                clientId: run.clientId, leadId: run.leadId, dueAt: nextDue, channel: run.channel,
                subject: run.subject, text: run.text, stopOn: run.stopOn, doAlso: run.doAlso,
                matchKeys: run.matchKeys, status: 'scheduled',
              },
            },
            { upsert: true },
          );
        }
      }
      return queued ? 'queued' : 'sent';
    }
    await finish('skipped', { reason: `Delivery ${result}.` });
    return 'skipped';
  } catch (error) {
    // Never retry blindly: one channel may already have gone. The reminder history shows it.
    await finish('failed', { reason: String(error.message || 'Delivery failed').slice(0, 500) });
    return 'failed';
  }
}

// When the worker was down, several steps of one occurrence can be due at once: send only the
// latest and mark the older ones skipped, so a customer never gets a burst.
async function dispatchDue(now = new Date(), limit = 100) {
  const due = await Run.find({ source: 'action', status: 'scheduled', dueAt: { $lte: now } }).sort({ dueAt: 1 }).limit(limit).lean();
  const latest = new Map();
  for (const run of due) latest.set(`${run.ruleId}:${run.occurrenceKey}`, run);
  let sent = 0;
  for (const run of due) {
    if (latest.get(`${run.ruleId}:${run.occurrenceKey}`)._id.equals(run._id)) continue;
    await Run.updateOne({ _id: run._id, status: 'scheduled' }, { $set: { status: 'skipped', reason: 'A later message of this reminder was due at the same time.' } });
  }
  for (const run of latest.values()) { await dispatchRun(run._id, now); sent++; }
  return sent;
}

// Plans due-date steps for upcoming monthly cycles before the renewal invoice is created.
async function planProjectedMonthlyRuns() {
  const projectedActions = ['invoice.created', 'plan.started', 'package.purchased'];
  const rules = await Rule.find({
    ...activeRuleFilter(),
    $or: [{ action: { $in: projectedActions } }, { actions: { $in: projectedActions } }],
    kind: 'reminder',
    enabled: true,
    control: { $in: ['auto', 'review'] },
    'scope.kind': { $in: ['all', 'monthly', 'package', 'include', 'exclude'] },
    'steps.timingRef': { $in: ['before_due', 'on_due', 'after_due'] },
  }).lean();
  if (!rules.length) return 0;
  const { packageReminderCandidate } = require('./packageReminderEligibility');
  const orders = await Order.find({
    isServicePlan: true,
    'salesPackage.package.id': { $exists: true, $ne: null },
    paymentPolicy: null,
    orderVisibility: { $ne: 'cancelled' },
    servicePlanStatus: 'active',
    serviceAutoRenewalStoppedAt: null,
  }).select('userId isServicePlan salesPackage servicePlanSnapshot orderItems servicePlanStatus serviceAutoRenewalStoppedAt serviceNextBillingDate serviceBillingCycleMonths serviceCurrentCycleNumber serviceTotalCycles serviceBillingTenureMonths serviceCyclePrice serviceStartNotifiedAt createdAt currentMonthUpdatesRemaining demoMode projectProgress installments expectedCompletionDate').lean();
  if (!orders.length) return 0;
  const needsUploadCheck = rules.some(rule => rule.condition === 'upload_pending');
  const needsPendingCheck = rules.some(rule => ['unpaid', 'pending_approval', 'installment_due'].includes(rule.condition));
  const ruleIds = rules.map(rule => rule._id);
  let planned = 0;
  for (const order of orders) {
    const candidate = packageReminderCandidate(order, null);
    if (!candidate) continue;
    const packageSlug = packageSlugOf(order);
    const hasUploaded = needsUploadCheck ? await orderHasUpload(order) : false;
    const isPendingApproval = needsPendingCheck ? await orderHasPendingApproval(order) : false;
    const remainingLimit = orderRemainingLimit(order);
    const progress = Number(order.projectProgress || 0);
    const ctx = {
      invoice: null, order, isPaid: false, isPendingApproval, isInstallmentDue: false,
      progress, remainingLimit, isMonthly: true, packageSlug, hasUploaded, originSurface: '',
      dueDate: candidate.due, expiryDate: candidate.due, deadlineDate: order.expectedCompletionDate || candidate.due,
    };
    const occurrenceKey = `projected:${order._id}:${candidate.cycle}`;
    const existingRows = await Run.find({ ruleId: { $in: ruleIds }, occurrenceKey }).select('ruleId ruleRevision step').lean();
    const existingKeys = new Set(existingRows.map(row => `${row.ruleId}:${row.ruleRevision}:${row.step}`));
    for (const rule of rules) {
      if (!rule.activatedAt) continue;
      const activatedAt = new Date(rule.activatedAt);
      const startedAfterActivation = order.serviceStartNotifiedAt && new Date(order.serviceStartNotifiedAt) >= activatedAt;
      if (!startedAfterActivation && candidate.due <= activatedAt) continue;
      if (!ruleMatchesContext(rule, ctx)) continue;
      const dueSteps = (rule.steps || []).filter(st => ['before_due', 'on_due', 'after_due'].includes(st.timingRef));
      if (!dueSteps.length) continue;
      const fakeEvent = {
        action: rule.action,
        key: occurrenceKey,
        entityId: order._id,
        clientId: order.userId,
        leadId: null,
        occurredAt: activatedAt,
        matchKeys: [`order:${order._id}`],
        details: { dueDate: candidate.due },
      };
      for (const run of planRuns({ ...rule, steps: dueSteps }, fakeEvent, candidate.due)) {
        if (!startedAfterActivation && run.dueAt < activatedAt) continue;
        const stepKey = `${run.ruleId}:${run.ruleRevision}:${run.step}`;
        if (existingKeys.has(stepKey)) continue;
        const id = { ruleId: run.ruleId, ruleRevision: run.ruleRevision, occurrenceKey: run.occurrenceKey, step: run.step };
        await Run.updateOne(id, { $setOnInsert: run }, { upsert: true });
        existingKeys.add(stepKey);
        planned++;
      }
    }
  }
  return planned;
}

async function processActionRules(now = new Date(), { plan = true } = {}) {
  if (!enabled()) return { enabled: false };
  const events = await processEvents();
  const projected = plan ? await planProjectedMonthlyRuns() : 0;
  const dispatched = await dispatchDue(now);
  return { enabled: true, events, projected, dispatched };
}

async function hasActiveActionRule(action, scopeKind = null) {
  if (!enabled()) return false;
  const filter = { ...activeRuleFilter(), $or: [{ action }, { actions: action }], enabled: true, control: { $in: ['auto', 'review'] } };
  if (scopeKind) filter['scope.kind'] = scopeKind;
  return !!(await Rule.exists(filter));
}

/**
 * Safely enrolls currently open unpaid invoices into an active `invoice.created` reminder rule.
 * Idempotent via `occurrenceKey: invoice.created:<invoiceId>` and never bursts missed steps (dispatchDue sends only latest).
 */
async function enrollPendingInvoices(ruleId, { dryRun = true } = {}) {
  const rule = await Rule.findById(ruleId).lean();
  if (!rule) throw Object.assign(new Error('Rule not found.'), { status: 404 });
  if (!rule.enabled || !['auto', 'review'].includes(rule.control) || rule.kind !== 'reminder' || rule.action !== 'invoice.created') {
    throw Object.assign(new Error('Only active invoice reminder rules can enroll pending invoices.'), { status: 400 });
  }
  const invoices = await Invoice.find({
    invoiceType: { $in: BILLED },
    status: { $in: OPEN },
    amount: { $gt: 0 },
  }).sort({ dueDate: 1 }).lean();

  let count = 0;
  let enrolled = 0;
  const samples = [];
  for (const invoice of invoices) {
    const order = invoice.orderId ? await Order.findById(invoice.orderId).lean() : null;
    if (order && (order.orderVisibility === 'cancelled' || order.status === 'cancelled')) continue;
    const isMonthly = invoice.invoiceType === 'plan_renewal' || !!order?.salesPackage || !!order?.isServicePlan;
    const isOfferPayment = !!order?.paymentPolicy;
    const offerOffsets = Array.isArray(order?.paymentPolicy?.reminderOffsets) ? order.paymentPolicy.reminderOffsets : [];
    const packageSlug = packageSlugOf(order);
    const hasUploaded = order ? await orderHasUpload(order) : false;
    const dueDate = invoice.dueDate || order?.serviceNextBillingDate || null;
    const ctx = { invoice, order, isPaid: false, isMonthly, isOfferPayment, offerOffsets, packageSlug, hasUploaded, originSurface: '', dueDate };
    if (!ruleMatchesContext(rule, ctx)) continue;

    const occurrenceKey = `invoice.created:${String(invoice._id)}`;
    if (await Run.exists({ ruleId: rule._id, occurrenceKey })) continue;

    const fakeEvent = {
      action: 'invoice.created',
      key: occurrenceKey,
      entityId: invoice._id,
      clientId: invoice.userId || order?.userId || null,
      leadId: null,
      occurredAt: invoice.createdAt || new Date(),
      matchKeys: [`invoice:${String(invoice._id)}`, ...(invoice.orderId ? [`order:${String(invoice.orderId)}`] : [])],
      details: { dueDate },
    };
    const runs = planRuns(rule, fakeEvent, dueDate, ctx);
    if (!runs.length) continue;

    count++;
    if (samples.length < 5) {
      const user = invoice.userId ? await User.findById(invoice.userId).select('name email').lean() : null;
      samples.push({
        customer: user?.name || user?.email || 'Customer',
        amount: Number(invoice.amount - (invoice.amountPaid || 0)),
        dueDate,
      });
    }
    if (!dryRun) {
      for (const run of runs) {
        const id = { ruleId: run.ruleId, ruleRevision: run.ruleRevision, occurrenceKey: run.occurrenceKey, step: run.step };
        await Run.updateOne(id, { $setOnInsert: run }, { upsert: true });
      }
      enrolled++;
    }
  }
  return { dryRun, count, enrolled, samples };
}

module.exports = { processActionRules, processEvents, planProjectedMonthlyRuns, dispatchDue, dispatchRun, planRuns, stillValid, actionEligibility, resolveEventContext, ruleMatchesContext, executeDoAlso, normalizePlaceholders, hasActiveActionRule, enrollPendingInvoices };
