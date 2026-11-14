const Event = require('../models/communicationActionEventModel');

// Business actions that action rules can start from or stop on (Reminder.md §4, phase 1).
// `trigger: false` = usable only as a stop action for now.
const ACTIONS = {
  'invoice.created': { label: 'Invoice created', trigger: true },
  'payment.received': { label: 'Payment received', trigger: true },
  'project.completed': { label: 'Project completed', trigger: true },
  'plan.started': { label: 'Plan started', trigger: true },
};
const enabled = () => process.env.ACTION_RULES_ENABLED === 'true';

// Records one action. Inside a session the event commits or aborts with the business change.
// `key` makes it idempotent: the same action on the same record is recorded once.
// With ACTION_RULES_ENABLED off nothing is written, so existing flows are unchanged.
async function emitAction(action, { key, entityId, clientId = null, orderId = null, matchKeys = [], details = {}, occurredAt = new Date() }, { session = null } = {}) {
  if (!enabled()) return false;
  if (!ACTIONS[action]) throw new Error(`Unknown action ${action}`);
  const doc = { action, entityId, clientId, orderId, matchKeys, details, occurredAt, status: 'new' };
  try {
    await Event.updateOne({ key }, { $setOnInsert: { key, ...doc } }, { upsert: true, ...(session ? { session } : {}) });
    return true;
  } catch (error) {
    // In a transaction the caller must see the failure so the whole change rolls back together.
    if (session) throw error;
    console.error('[action event]', action, error.message);
    return false;
  }
}

const id = value => (value ? String(value) : '');
const invoiceKeys = invoice => [`invoice:${id(invoice._id)}`, ...(invoice.orderId ? [`order:${id(invoice.orderId)}`] : [])];

const invoiceCreated = (invoice, session) => emitAction('invoice.created', {
  key: `invoice.created:${id(invoice._id)}`, entityId: invoice._id, clientId: invoice.userId, orderId: invoice.orderId,
  matchKeys: invoiceKeys(invoice), occurredAt: invoice.createdAt || new Date(),
  details: { invoiceType: invoice.invoiceType, amount: invoice.amount, dueDate: invoice.dueDate, invoiceNumber: invoice.invoiceNumber },
}, { session });

// Only a fully paid invoice counts. The order key is added later by the worker, once it knows
// that no other invoice of the order is still open (helpers/actionRuleWorker.js).
const paymentReceived = (invoice, session) => (invoice.status !== 'paid' ? Promise.resolve(false) : emitAction('payment.received', {
  key: `payment.received:${id(invoice._id)}`, entityId: invoice._id, clientId: invoice.userId, orderId: invoice.orderId,
  matchKeys: [`invoice:${id(invoice._id)}`], details: { amount: invoice.amount, invoiceNumber: invoice.invoiceNumber },
}, { session }));

function projectCompleted(order) {
  if (!(Number(order.projectProgress) >= 100)) return Promise.resolve(false);
  const round = (order.lifecycleEvents || []).filter(row => row.eventType === 'completed').length || 1;
  return emitAction('project.completed', { key: `project.completed:${id(order._id)}:${round}`, entityId: order._id,
    clientId: order.userId, orderId: order._id, matchKeys: [`order:${id(order._id)}`] });
}

const planStarted = order => emitAction('plan.started', { key: `plan.started:${id(order._id)}`, entityId: order._id,
  clientId: order.userId, orderId: order._id, matchKeys: [`order:${id(order._id)}`] });

module.exports = { ACTIONS, enabled, emitAction, invoiceCreated, paymentReceived, projectCompleted, planStarted };
