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
  'lead.created': { label: 'Lead created', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'client.account_created': { label: 'Client account created', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'lead.proposal': { label: 'Proposal sent', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'lead.message': { label: 'Message sent to lead', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'upload.completed': { label: 'Update request / upload completed', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'order.upi_pending': { label: 'Order created (UPI pending)', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'invoice.resent': { label: 'Invoice resent', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'invoice.manual_reminder': { label: 'Manual payment reminder', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'plan.requested': { label: 'Plan requested', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'plan.work_updated': { label: 'Plan work update added', trigger: true, supportsScope: true, conditions: ALWAYS_ONLY },
  'plan.upload_updated': { label: 'Plan upload status changed', trigger: true, supportsScope: true, conditions: ALWAYS_ONLY },
  'plan.payment_rejected': { label: 'Plan or wallet payment rejected', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'plan.purchased': { label: 'Service plan purchased', trigger: true, supportsScope: true, conditions: ALWAYS_ONLY },
  'project.cancelled': { label: 'Project cancelled', trigger: true, supportsScope: true, conditions: ALWAYS_ONLY },
  'project.upgraded': { label: 'Project complimentary upgrade', trigger: true, supportsScope: true, conditions: ALWAYS_ONLY },
  'project.step_updated': { label: 'Project step update', trigger: true, supportsScope: true, conditions: ALWAYS_ONLY },
  'package.purchased': { label: 'Package purchased', trigger: true, supportsScope: true, conditions: ALWAYS_ONLY },
  'wallet.recharged': { label: 'Wallet recharged', trigger: true, supportsScope: false, conditions: ALWAYS_ONLY },
  'plan.closed': { label: 'Plan closed / renewal stopped', trigger: true, supportsScope: true, conditions: ALWAYS_ONLY },
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

const leadCreated = lead => {
  if (!lead?._id) return Promise.resolve(false);
  return emitAction('lead.created', {
    key: `lead.created:${id(lead._id)}`,
    entityId: lead._id,
    leadId: lead._id,
    matchKeys: [`lead:${id(lead._id)}`],
    occurredAt: lead.createdAt || new Date(),
  });
};

const clientAccountCreated = user => {
  if (!user?._id) return Promise.resolve(false);
  return emitAction('client.account_created', {
    key: `client.account_created:${id(user._id)}`,
    entityId: user._id,
    clientId: user._id,
    matchKeys: [`client:${id(user._id)}`],
  });
};

const leadProposalSent = (lead, version = 1) => {
  if (!lead?._id) return Promise.resolve(false);
  return emitAction('lead.proposal', {
    key: `lead.proposal:${id(lead._id)}:${version}:${Date.now()}`,
    entityId: lead._id,
    leadId: lead._id,
    matchKeys: [`lead:${id(lead._id)}`],
    details: { version },
  });
};

const leadMessageSent = lead => {
  if (!lead?._id) return Promise.resolve(false);
  return emitAction('lead.message', {
    key: `lead.message:${id(lead._id)}:${Date.now()}`,
    entityId: lead._id,
    leadId: lead._id,
    matchKeys: [`lead:${id(lead._id)}`],
  });
};

const uploadCompleted = record => {
  if (!record?._id) return Promise.resolve(false);
  return emitAction('upload.completed', {
    key: `upload.completed:${id(record._id)}`,
    entityId: record._id,
    clientId: record.userId || null,
    matchKeys: [`upload:${id(record._id)}`],
    details: { title: record.title || record.subject || '' },
  });
};

const orderUpiPending = order => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('order.upi_pending', {
    key: `order.upi_pending:${id(order._id)}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
  });
};

const invoiceResent = invoice => {
  if (!invoice?._id) return Promise.resolve(false);
  return emitAction('invoice.resent', {
    key: `invoice.resent:${id(invoice._id)}:${Date.now()}`,
    entityId: invoice._id,
    clientId: invoice.userId || null,
    orderId: invoice.orderId || null,
    matchKeys: invoiceKeys(invoice),
  });
};

const invoiceManualReminder = invoice => {
  if (!invoice?._id) return Promise.resolve(false);
  return emitAction('invoice.manual_reminder', {
    key: `invoice.manual_reminder:${id(invoice._id)}:${Date.now()}`,
    entityId: invoice._id,
    clientId: invoice.userId || null,
    orderId: invoice.orderId || null,
    matchKeys: invoiceKeys(invoice),
  });
};

const planRequested = (lead, planName = '') => {
  if (!lead?._id) return Promise.resolve(false);
  return emitAction('plan.requested', {
    key: `plan.requested:${id(lead._id)}:${Date.now()}`,
    entityId: lead._id,
    leadId: lead._id,
    matchKeys: [`lead:${id(lead._id)}`],
    details: { planName },
  });
};

const planWorkUpdated = (order, entryId) => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('plan.work_updated', {
    key: `plan.work_updated:${id(order._id)}:${id(entryId)}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
  });
};

const planUploadUpdated = (order, requestId, status) => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('plan.upload_updated', {
    key: `plan.upload_updated:${id(requestId)}:${status}:${Date.now()}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
    details: { status },
  });
};

const planPaymentRejected = (order, reason = '') => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('plan.payment_rejected', {
    key: `plan.payment_rejected:${id(order._id)}:${Date.now()}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
    details: { reason },
  });
};

const planPurchased = order => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('plan.purchased', {
    key: `plan.purchased:${id(order._id)}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
  });
};

const projectCancelled = order => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('project.cancelled', {
    key: `project.cancelled:${id(order._id)}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
  });
};

const projectUpgraded = (order, stage = 'offer') => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('project.upgraded', {
    key: `project.upgraded:${id(order._id)}:${stage}:${Date.now()}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
    details: { stage },
  });
};

const projectStepUpdated = (order, nodeId) => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('project.step_updated', {
    key: `project.step_updated:${id(order._id)}:${id(nodeId)}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
  });
};

const packagePurchased = order => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('package.purchased', {
    key: `package.purchased:${id(order._id)}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
  });
};

const reservationExtended = row => {
  if (!row?._id || !row?.userId) return Promise.resolve(false);
  return emitAction('reservation.extended', {
    key: `reservation.extended:${id(row._id)}:${(row.extensions || []).length}`,
    entityId: row._id,
    clientId: row.userId,
    matchKeys: [`reservation:${id(row._id)}`],
    details: { dueDate: row.extendedUntil || row.expiresAt },
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
  leadCreated,
  clientAccountCreated,
  leadProposalSent,
  leadMessageSent,
  uploadCompleted,
  orderUpiPending,
  invoiceResent,
  invoiceManualReminder,
  planRequested,
  planWorkUpdated,
  planUploadUpdated,
  planPaymentRejected,
  planPurchased,
  projectCancelled,
  projectUpgraded,
  projectStepUpdated,
  packagePurchased,
  reservationExtended,
};
