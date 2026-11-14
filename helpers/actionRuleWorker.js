const { randomUUID } = require('node:crypto');
const Event = require('../models/communicationActionEventModel');
const Rule = require('../models/communicationActionRuleModel');
const Run = require('../models/communicationReminderRunModel');
const Invoice = require('../models/invoiceModel');
const Order = require('../models/orderProductModel');
const User = require('../models/userModel');
const { ACTIONS, enabled } = require('./actionEvents');

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

// Steps first, then repeats after the last step. Due times count from the moment of the action.
function planRuns(rule, event) {
  const at = days => new Date(+new Date(event.occurredAt) + days * DAY);
  const sends = rule.steps.map(step => ({ ...step, dueAt: at(step.afterDays) }));
  const last = rule.steps[rule.steps.length - 1];
  for (let n = 1; n <= (rule.repeat?.times || 0); n++) sends.push({ ...last, dueAt: at(last.afterDays + n * rule.repeat.everyDays) });
  return sends.map((send, step) => ({
    ruleId: rule._id, ruleRevision: rule.revision, source: 'action', action: event.action, occurrenceKey: event.key, step,
    entityId: event.entityId, clientId: event.clientId, dueAt: send.dueAt, channel: send.channel,
    subject: send.subject || ACTIONS[event.action].label, text: send.text, stopOn: rule.stopOn, matchKeys: event.matchKeys, status: 'scheduled',
  }));
}

async function handleEvent(event) {
  let keys = event.matchKeys || [];
  if (event.action === 'payment.received' && await orderFullyPaid(event.orderId)) keys = [...keys, `order:${event.orderId}`];
  if (keys.length) {
    await Run.updateMany({ source: 'action', status: 'scheduled', stopOn: event.action, matchKeys: { $in: keys } },
      { $set: { status: 'cancelled', reason: `Stopped: ${ACTIONS[event.action].label}.` } });
  }
  if (!event.clientId) return;
  const rules = await Rule.find({ action: event.action, enabled: true, control: 'auto', activatedAt: { $lte: event.occurredAt } }).lean();
  for (const rule of rules) {
    for (const run of planRuns(rule, event)) {
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
  const rule = await Rule.findOne({ _id: run.ruleId, enabled: true, control: 'auto' }).select('_id').lean();
  if (!rule) return { ok: false, reason: 'Rule is off.' };
  const client = await User.findById(run.clientId).select('name email phone isActive isGuest deletedAt').lean();
  if (!client || client.isActive === false || client.isGuest || client.deletedAt) return { ok: false, reason: 'Customer is unavailable.' };
  const waitsForPayment = (run.stopOn || []).includes('payment.received');
  let invoice = null, order = null;
  if (run.action === 'invoice.created' || run.action === 'payment.received') {
    invoice = await Invoice.findById(run.entityId).lean();
    if (!invoice || invoice.status === 'cancelled') return { ok: false, reason: 'Invoice is unavailable.' };
    if (waitsForPayment && !OPEN.includes(invoice.status)) return { ok: false, reason: 'Invoice is already paid.' };
    order = invoice.orderId ? await Order.findById(invoice.orderId).select('orderItems servicePlanSnapshot orderVisibility').lean() : null;
  } else {
    order = await Order.findById(run.entityId).select('orderItems servicePlanSnapshot orderVisibility status servicePlanStatus').lean();
    if (!order || order.orderVisibility === 'cancelled' || order.status === 'cancelled') return { ok: false, reason: 'Project or plan is unavailable.' };
    if (waitsForPayment && await orderFullyPaid(order._id)) return { ok: false, reason: 'Payment is complete.' };
  }
  return { ok: true, client, invoice, order };
}

// Same check for the email provider and WhatsApp handoff (communicationReminderEligibility.js),
// plus: the destination must still be the customer's current email or phone.
async function actionEligibility(run, target = {}) {
  const check = await stillValid(run);
  if (!check.ok) return { allowed: false, reason: check.reason };
  const digits = value => String(value || '').replace(/\D/g, '');
  if (target.phone && digits(target.phone).slice(-10) !== digits(check.client.phone).slice(-10)) return { allowed: false, reason: 'WhatsApp destination changed.' };
  if (target.emails?.length && (target.emails.length !== 1 || String(target.emails[0]).toLowerCase() !== String(check.client.email || '').toLowerCase())) return { allowed: false, reason: 'Email destination changed.' };
  return { allowed: true, candidate: check };
}

const day = value => (value ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : '');
function portalLink(path) {
  try { const base = new URL(process.env.FORNTEND_URL); return ['http:', 'https:'].includes(base.protocol) ? new URL(path, base).toString() : ''; } catch { return ''; }
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
    const { client, invoice, order } = check;
    const values = { name: client.name || 'Customer', project: order?.orderItems?.[0]?.name || order?.servicePlanSnapshot?.serviceName || '',
      amount: invoice ? `₹${Number(invoice.amount - (invoice.amountPaid || 0)).toLocaleString('en-IN')}` : '', dueDate: day(invoice?.dueDate),
      invoiceLink: invoice ? portalLink(`/invoice-detail/${invoice._id}`) : '' };
    const key = `action-rule:${run._id}`;
    const { render } = require('./emailMarkup');
    const mail = { reviewed: true, to: client.email ? [client.email] : [], phone: client.phone,
      subject: render(run.subject, values, {}, { plain: true }), text: run.text, values, reminderRunId: run._id };
    const result = await require('./emailController').sendSystemMail('reminder.automated', mail, key, '/action-rules', { channel: run.channel });
    if (result === 'sent') {
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

module.exports = { processActionRules, processEvents, dispatchDue, dispatchRun, planRuns, stillValid, actionEligibility };
