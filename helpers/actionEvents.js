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
  'broadcast.sent': { label: 'Broadcast sent', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'reservation.start_requested': { label: 'Reservation start requested', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'package.start_requested': { label: 'Package start requested', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'project.created': { label: 'Project created', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'start_request.closed': { label: 'Start request closed', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'reservation.created': { label: 'Offer reserved', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'reservation.extended': { label: 'Reservation extended', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'reservation.expired': { label: 'Reservation expired', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'lead.final_message_started': { label: 'Final message started', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'final_message.stopped': { label: 'Final message stopped', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
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

const broadcastSent = (broadcastId, leadId, { anchorAt = new Date() } = {}) => {
  if (!broadcastId || !leadId) return Promise.resolve(false);
  return emitAction('broadcast.sent', {
    key: `broadcast.sent:${id(broadcastId)}:${id(leadId)}`,
    entityId: broadcastId,
    leadId,
    matchKeys: [`lead:${id(leadId)}`],
    occurredAt: anchorAt,
  });
};

const reservationStartRequested = (row, requestIndex = 0) => {
  if (!row?._id || !row?.userId) return Promise.resolve(false);
  const reqAt = row.startRequests?.[requestIndex]?.at || row.startRequestedAt || new Date();
  return emitAction('reservation.start_requested', {
    key: `reservation.start_requested:${id(row._id)}:${requestIndex}`,
    entityId: row._id,
    clientId: row.userId,
    leadId: row.leadId || null,
    matchKeys: [`reservation:${id(row._id)}`],
    occurredAt: reqAt,
    details: { requestIndex },
  });
};

const packageStartRequested = row => {
  if (!row?._id || !row?.userId) return Promise.resolve(false);
  return emitAction('package.start_requested', {
    key: `package.start_requested:${id(row._id)}`,
    entityId: row._id,
    clientId: row.userId,
    leadId: row.leadId || null,
    matchKeys: [`package_start:${id(row._id)}`],
    occurredAt: row.requestedAt || new Date(),
  });
};

const projectCreated = (order, { reservationId = null, packageStartId = null, session = null } = {}) => {
  if (!order?._id) return Promise.resolve(false);
  const matchKeys = [
    `order:${id(order._id)}`,
    ...(reservationId ? [`reservation:${id(reservationId)}`] : []),
    ...(packageStartId ? [`package_start:${id(packageStartId)}`] : []),
  ];
  return emitAction('project.created', {
    key: `project.created:${id(order._id)}`,
    entityId: order._id,
    clientId: order.userId || null,
    orderId: order._id,
    matchKeys,
    occurredAt: order.createdAt || new Date(),
  }, { session });
};

const startRequestClosed = ({ reservationId = null, packageStartId = null, clientId = null } = {}) => {
  if (!reservationId && !packageStartId) return Promise.resolve(false);
  const matchKeys = [
    ...(reservationId ? [`reservation:${id(reservationId)}`] : []),
    ...(packageStartId ? [`package_start:${id(packageStartId)}`] : []),
  ];
  const targetId = reservationId || packageStartId;
  return emitAction('start_request.closed', {
    key: `start_request.closed:${id(targetId)}:${Date.now()}`,
    entityId: targetId,
    clientId,
    matchKeys,
  });
};

const reservationCreated = (row, session = null) => {
  if (!row?._id || !row?.userId) return Promise.resolve(false);
  const deadline = row.extendedUntil || row.expiresAt;
  return emitAction('reservation.created', {
    key: `reservation.created:${id(row._id)}`,
    entityId: row._id,
    clientId: row.userId,
    leadId: row.leadId || null,
    matchKeys: [`reservation:${id(row._id)}`],
    occurredAt: row.reservedAt || new Date(),
    details: { dueDate: deadline },
  }, { session });
};

const reservationExpired = (row, now = new Date()) => {
  if (!row?._id) return Promise.resolve(false);
  return emitAction('reservation.expired', {
    key: `reservation.expired:${id(row._id)}`,
    entityId: row._id,
    clientId: row.userId || null,
    matchKeys: [`reservation:${id(row._id)}`],
    occurredAt: now,
  });
};

const finalMessageStarted = (row, { leadId = null, clientId = null } = {}) => {
  if (!row?._id || (!leadId && !clientId)) return Promise.resolve(false);
  return emitAction('lead.final_message_started', {
    key: `lead.final_message_started:${id(row._id)}`,
    entityId: row._id,
    leadId,
    clientId,
    matchKeys: [`final_message:${id(row._id)}`, ...(leadId ? [`lead:${id(leadId)}`] : [])],
    occurredAt: row.sentAt || new Date(),
  });
};

const finalMessageStopped = row => {
  if (!row?._id) return Promise.resolve(false);
  return emitAction('final_message.stopped', {
    key: `final_message.stopped:${id(row._id)}`,
    entityId: row._id,
    leadId: row.leadId || null,
    matchKeys: [`final_message:${id(row._id)}`],
  });
};

module.exports = {
  ACTIONS,
  enabled,
  emitAction,
  invoiceCreated,
  paymentReceived,
  projectCompleted,
  planStarted,
  whatsappAdReceived,
  broadcastSent,
  reservationStartRequested,
  packageStartRequested,
  projectCreated,
  startRequestClosed,
  reservationCreated,
  reservationExpired,
  finalMessageStarted,
  finalMessageStopped,
};
