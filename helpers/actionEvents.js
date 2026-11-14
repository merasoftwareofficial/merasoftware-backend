const Event = require('../models/communicationActionEventModel');

const PAYMENT_CONDITIONS = [
  { key: 'anytime', label: 'Anytime (always)' },
  { key: 'unpaid', label: 'Only if payment is pending (unpaid)' },
  { key: 'paid', label: 'Only if already paid' },
];
const ALWAYS_ONLY = [{ key: 'anytime', label: 'Anytime (always)' }];

// Business actions that action rules can start from or stop on (Reminder.md §4, phase 1-2).
// Each trigger declares its own allowed conditions and whether package/plan scope applies.
const ACTIONS = {
  'invoice.created': { label: 'Invoice created', trigger: true, supportsScope: true, conditions: PAYMENT_CONDITIONS },
  'payment.received': { label: 'Payment received', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'project.completed': { label: 'Project completed', trigger: true, supportsScope: true, conditions: PAYMENT_CONDITIONS },
  'plan.started': { label: 'Plan started', trigger: true, supportsScope: true, conditions: PAYMENT_CONDITIONS },
  'whatsapp.ad_received': { label: 'WhatsApp ad message received', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
};
const enabled = () => process.env.ACTION_RULES_ENABLED === 'true';

// Records one action. Inside a session the event commits or aborts with the business change.
// `key` makes it idempotent: the same action on the same record is recorded once.
// With ACTION_RULES_ENABLED off nothing is written, so existing flows are unchanged.
async function emitAction(action, { key, entityId, clientId = null, leadId = null, orderId = null, matchKeys = [], details = {}, occurredAt = new Date() }, { session = null } = {}) {
  if (!enabled()) return false;
  if (!ACTIONS[action]) throw new Error(`Unknown action ${action}`);
  const doc = { action, entityId, clientId, leadId, orderId, matchKeys, details, occurredAt, status: 'new' };
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

const whatsappAdReceived = (row, { leadId = null, clientId = null } = {}) => {
  if (!leadId && !clientId) return Promise.resolve(false);
  const matchKeys = [
    ...(leadId ? [`lead:${id(leadId)}`] : []),
    ...(clientId ? [`client:${id(clientId)}`] : []),
  ];
  return emitAction('whatsapp.ad_received', {
    key: `whatsapp.ad_received:${id(row._id)}`,
    entityId: row._id,
    clientId,
    leadId,
    matchKeys,
    occurredAt: row.sentAt || row.createdAt || new Date(),
    details: { phone: row.phone, text: row.text, profileName: row.profileName || '' },
  });
};

module.exports = { ACTIONS, enabled, emitAction, invoiceCreated, paymentReceived, projectCompleted, planStarted, whatsappAdReceived };
