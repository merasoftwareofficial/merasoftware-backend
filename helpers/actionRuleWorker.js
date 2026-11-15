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
const LOCK_MS = 120000;
const OPEN = ['unpaid', 'partially_paid', 'overdue'];
const BILLED = ['project', 'plan_renewal'];

async function orderFullyPaid(orderId) {
  if (!orderId) return false;
  return !await Invoice.exists({ orderId, invoiceType: { $in: BILLED }, status: { $in: OPEN } });
}

async function resolveEventContext(event) {
  if (event.action === 'whatsapp.ad_received') {
    return { invoice: null, order: null, isPaid: false, isMonthly: false, packageSlug: '', dueDate: null };
  }
  let invoice = null;
  let order = null;
  if (event.action === 'invoice.created' || event.action === 'payment.received') {
    invoice = await Invoice.findById(event.entityId).lean();
    order = invoice?.orderId ? await Order.findById(invoice.orderId).lean() : null;
  } else {
    order = await Order.findById(event.entityId).lean();
    if (order) {
      invoice = await Invoice.findOne({ orderId: order._id, invoiceType: { $in: BILLED }, status: { $ne: 'cancelled' } })
        .sort({ createdAt: -1 }).lean();
    }
  }
  const isPaid = invoice ? !OPEN.includes(invoice.status) : await orderFullyPaid(order?._id);
  const isMonthly = invoice?.invoiceType === 'plan_renewal' || !!order?.salesPackage || !!order?.isServicePlan;
  const packageSlug = String(
    order?.salesPackage?.packageSlug || order?.salesPackage?.slug || order?.salesPackage?.packageId ||
    order?.servicePlanSnapshot?.packageSlug || '',
  ).trim();
  const dueDate = invoice?.dueDate || order?.serviceNextBillingDate || event.details?.dueDate || null;
  return { invoice, order, isPaid, isMonthly, packageSlug, dueDate };
}

function ruleMatchesContext(rule, ctx) {
  if (rule.condition === 'unpaid' && ctx.isPaid) return false;
  if (rule.condition === 'paid' && !ctx.isPaid) return false;
  const scopeKind = rule.scope?.kind || 'all';
  if (scopeKind === 'monthly' && !ctx.isMonthly) return false;
  if (scopeKind === 'one_time' && ctx.isMonthly) return false;
  if (scopeKind === 'package' && (!rule.scope?.packageSlug || ctx.packageSlug !== rule.scope.packageSlug)) return false;
  return true;
}

function stepDueAt(step, occurredAt, dueDate) {
  const days = step.days !== undefined ? step.days : (step.afterDays || 0);
  const ref = step.timingRef || 'after_action';
  if (ref === 'after_action') return new Date(+new Date(occurredAt) + days * DAY);
  if (!dueDate) return null;
  const base = +new Date(dueDate);
  if (ref === 'before_due') return new Date(base - days * DAY);
  if (ref === 'on_due') return new Date(base);
  if (ref === 'after_due') return new Date(base + days * DAY);
  return null;
}

// Steps first, then repeats after the last step.
function planRuns(rule, event, dueDate = event.details?.dueDate || null) {
  const sends = [];
  for (const step of rule.steps) {
    const dueAt = stepDueAt(step, event.occurredAt, dueDate);
    if (dueAt) sends.push({ ...step, dueAt });
  }
  if (!sends.length) return [];
  const last = sends[sends.length - 1];
  for (let n = 1; n <= (rule.repeat?.times || 0); n++) {
    sends.push({ ...last, dueAt: new Date(+last.dueAt + n * rule.repeat.everyDays * DAY) });
  }
  return sends.map((send, step) => ({
    ruleId: rule._id,
    ruleRevision: rule.revision,
    source: 'action',
    action: event.action,
    audience: rule.audience || 'customer',
    occurrenceKey: event.key,
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

async function handleEvent(event) {
  let keys = event.matchKeys || [];
  if (event.action === 'payment.received' && await orderFullyPaid(event.orderId)) keys = [...keys, `order:${event.orderId}`];
  if (keys.length) {
    await Run.updateMany({ source: 'action', status: 'scheduled', stopOn: event.action, matchKeys: { $in: keys } },
      { $set: { status: 'cancelled', reason: `Stopped: ${ACTIONS[event.action].label}.` } });
  }
  if (!event.clientId && !event.leadId) return;
  const rules = await Rule.find({ action: event.action, enabled: true, control: 'auto', activatedAt: { $lte: event.occurredAt } }).lean();
  if (!rules.length) return;
  const ctx = await resolveEventContext(event);
  for (const rule of rules) {
    if (!ruleMatchesContext(rule, ctx)) continue;
    for (const run of planRuns(rule, event, ctx.dueDate)) {
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
  const rule = await Rule.findOne({ _id: run.ruleId, enabled: true, control: 'auto' }).select('_id condition').lean();
  if (!rule) return { ok: false, reason: 'Rule is off.' };
  let client = null;
  let lead = run.leadId ? await Lead.findById(run.leadId).select('name email phone status convertedToUserId deletedAt').lean() : null;
  if (run.clientId) {
    client = await User.findById(run.clientId).select('name email phone isActive isGuest deletedAt').lean();
    if (!client || client.isActive === false || client.isGuest || client.deletedAt) return { ok: false, reason: 'Customer is unavailable.' };
  } else if (lead && !lead.deletedAt) {
    client = { name: lead.name || 'Customer', email: lead.email || '', phone: lead.phone || '' };
  } else {
    return { ok: false, reason: 'Customer or lead is unavailable.' };
  }
  const waitsForPayment = (run.stopOn || []).includes('payment.received') || rule.condition === 'unpaid';
  let invoice = null, order = null;
  if (run.action === 'whatsapp.ad_received') {
    // No invoice or order attached to an incoming WhatsApp message.
  } else if (run.action === 'invoice.created' || run.action === 'payment.received') {
    invoice = await Invoice.findById(run.entityId).lean();
    if (!invoice || invoice.status === 'cancelled') return { ok: false, reason: 'Invoice is unavailable.' };
    if (waitsForPayment && !OPEN.includes(invoice.status)) return { ok: false, reason: 'Invoice is already paid.' };
    order = invoice.orderId ? await Order.findById(invoice.orderId).select('orderItems servicePlanSnapshot salesPackage orderVisibility serviceNextBillingDate serviceBillingCycleMonths').lean() : null;
  } else {
    order = await Order.findById(run.entityId).select('orderItems servicePlanSnapshot salesPackage orderVisibility status servicePlanStatus serviceNextBillingDate serviceBillingCycleMonths').lean();
    if (!order || order.orderVisibility === 'cancelled' || order.status === 'cancelled') return { ok: false, reason: 'Project or plan is unavailable.' };
    if (waitsForPayment && await orderFullyPaid(order._id)) return { ok: false, reason: 'Payment is complete.' };
  }
  if (run.audience === 'admin') {
    const contacts = await teamContacts();
    if (!contacts.length) return { ok: false, reason: 'No admin contact configured.' };
    return { ok: true, client, lead, invoice, order, contacts };
  }
  return { ok: true, client, lead, invoice, order };
}

// Same check for the email provider and WhatsApp handoff (communicationReminderEligibility.js),
// plus: the destination must still match the customer or configured admin contacts.
async function actionEligibility(run, target = {}) {
  const check = await stillValid(run);
  if (!check.ok) return { allowed: false, reason: check.reason };
  const digits = value => String(value || '').replace(/\D/g, '');
  if (run.audience === 'admin') {
    const adminEmails = new Set((await teamRecipients()).map(e => e.toLowerCase()));
    const adminPhones = new Set((check.contacts || []).flatMap(c => c.numbers).map(n => digits(n).slice(-10)).filter(Boolean));
    if (target.phone && !adminPhones.has(digits(target.phone).slice(-10))) return { allowed: false, reason: 'Admin WhatsApp destination changed.' };
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
  'name', 'amount', 'dueDate', 'invoiceLink', 'projectLink', 'packageLink', 'portalLink',
  'project', 'planName', 'duration', 'email', 'phone',
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
    const packageSlug = order?.salesPackage?.slug || '';
    const months = order?.salesPackage?.months || order?.serviceBillingCycleMonths || order?.servicePlanSnapshot?.selectedBillingCycleMonths;
    const duration = months ? `${months} month${months > 1 ? 's' : ''}` : '';
    const values = {
      name: client.name || 'Customer',
      email: client.email || '',
      phone: client.phone || '',
      project: order?.orderItems?.[0]?.name || planName,
      planName,
      duration,
      amount: invoice ? `₹${Number(invoice.amount - (invoice.amountPaid || 0)).toLocaleString('en-IN')}` : '',
      dueDate: day(invoice?.dueDate || order?.serviceNextBillingDate),
      invoiceLink: invoice ? portalLink(`/invoice-detail/${invoice._id}`) : '',
      projectLink: order?._id ? portalLink(`/project-details/${order._id}`) : '',
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
      to,
      phone,
      subject: render(normalizePlaceholders(run.subject), values, {}, { plain: true }),
      text: normalizePlaceholders(run.text),
      values,
      reminderRunId: run._id,
    };
    const result = await require('./emailController').sendSystemMail('reminder.automated', mail, key, '/action-rules', { channel: run.channel });
    if (result === 'sent') {
      await executeDoAlso(run, check, values, render);
      const { EmailDraft } = require('../models/emailControlModel');
      const draft = await EmailDraft.findOne({ dedupeKey: key }).select('_id delivery sentAt').lean();
      const queued = draft?.delivery?.whatsappStatus === 'queued';
      await finish(queued ? 'queued' : 'sent', { ...(draft?._id ? { emailDraftId: draft._id } : {}), ...(!queued ? { sentAt: draft?.sentAt || new Date() } : {}) });
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

async function processActionRules(now = new Date()) {
  if (!enabled()) return { enabled: false };
  const events = await processEvents();
  const dispatched = await dispatchDue(now);
  return { enabled: true, events, dispatched };
}

module.exports = { processActionRules, processEvents, dispatchDue, dispatchRun, planRuns, stillValid, actionEligibility, resolveEventContext, ruleMatchesContext, executeDoAlso, normalizePlaceholders };
