const Event = require('../models/communicationActionEventModel');

const PAYMENT_CONDITIONS = [
  { key: 'anytime', label: 'Anytime (always)' },
  { key: 'unpaid', label: 'Only if payment is still unpaid' },
  { key: 'pending_approval', label: 'Only if UPI is submitted (waiting for admin approval)' },
  { key: 'paid', label: 'Only if already paid' },
  { key: 'installment_due', label: 'Only if current installment is due (unpaid)' },
];
const PACKAGE_CONDITIONS = [
  ...PAYMENT_CONDITIONS,
  { key: 'upload_pending', label: 'Only if data upload is pending' },
];
const ALWAYS_ONLY = [{ key: 'anytime', label: 'Anytime (always)' }];

const FOLDERS = [
  'Payments & Invoices',
  'Projects & Previews',
  'Plans & Packages',
  'Data Uploads & Documents',
  'Leads, Offers & Reservations',
  'Login, Profile, Accounts & Support',
  'Website Content, Products, Broadcast & Settings',
];

// Master SSOT Work Registry (Reminder.md §2-3).
// Every business work ("kaam") declares its folder, plain-English meaning (`when`), entity context (`entityType`),
// allowed dynamic conditions, whether it can stop a reminder (`canStop`), and its natural stop group (`defaultStopOn`).
const ACTIONS = {
  // 1. Payments & Invoices
  'invoice.created': {
    label: 'Payment Due (Any Bill / Order / Installment / Renewal)',
    folder: 'Payments & Invoices',
    when: 'When any project, plan, package, installment, or monthly renewal creates a due bill.',
    entityType: 'invoice',
    trigger: true,
    supportsScope: true,
    supportsLimit: true,
    conditions: PACKAGE_CONDITIONS,
    defaultStopOn: ['payment.received', 'order.upi_pending'],
  },
  'payment.received': {
    label: 'Payment Approved / Recorded (Paid)',
    folder: 'Payments & Invoices',
    when: 'When an invoice or order is approved, recorded paid, or paid via wallet/installment.',
    entityType: 'invoice',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'order.upi_pending': {
    label: 'Payment Submitted by Client (Approval Pending)',
    folder: 'Payments & Invoices',
    when: 'When a client submits a UPI order or installment payment waiting for admin approval.',
    entityType: 'order',
    trigger: true,
    canStop: true,
    supportsScope: true,
    conditions: PAYMENT_CONDITIONS,
    defaultStopOn: ['payment.received', 'plan.payment_rejected'],
  },
  'plan.payment_rejected': {
    label: 'Payment Rejected (by Admin)',
    folder: 'Payments & Invoices',
    when: 'When an admin rejects a submitted plan, order, or wallet payment.',
    entityType: 'order',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'wallet.recharged': {
    label: 'Wallet recharged',
    folder: 'Payments & Invoices',
    when: 'When an admin recharges a client wallet or demo credit is added.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'invoice.resent': {
    label: 'Invoice resent',
    folder: 'Payments & Invoices',
    when: 'When an admin resends a project final invoice or monthly payment invoice.',
    entityType: 'invoice',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'invoice.manual_reminder': {
    label: 'Manual payment reminder',
    folder: 'Payments & Invoices',
    when: 'When an admin manually triggers a payment reminder from payment records.',
    entityType: 'invoice',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'bank.account_updated': {
    label: 'Bank account added, updated or deleted',
    folder: 'Payments & Invoices',
    when: 'When a user adds, edits, or removes a saved payout bank account.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },

  // 2. Projects & Previews
  'project.created': {
    label: 'Project created',
    folder: 'Projects & Previews',
    when: 'When a new project is created by an admin, requested by a client, or started from a package.',
    entityType: 'order',
    trigger: true,
    canStop: true,
    supportsScope: true,
    supportsProgress: true,
    conditions: PACKAGE_CONDITIONS,
    defaultStopOn: ['payment.received'],
  },
  'project.step_updated': {
    label: 'Project step update',
    folder: 'Projects & Previews',
    when: 'When project steps or progress % change (use Progress >= X% or Installment due for milestone reminders).',
    entityType: 'order',
    trigger: true,
    supportsScope: true,
    supportsProgress: true,
    conditions: PACKAGE_CONDITIONS,
    defaultStopOn: ['payment.received', 'project.completed'],
  },
  'project.completed': {
    label: 'Project completed',
    folder: 'Projects & Previews',
    when: 'When a project reaches 100% progress.',
    entityType: 'order',
    trigger: true,
    canStop: true,
    supportsScope: true,
    supportsProgress: true,
    conditions: PAYMENT_CONDITIONS,
    defaultStopOn: ['payment.received'],
  },
  'project.cancelled': {
    label: 'Project cancelled',
    folder: 'Projects & Previews',
    when: 'When an admin cancels a project order.',
    entityType: 'order',
    trigger: true,
    canStop: true,
    supportsScope: true,
    conditions: ALWAYS_ONLY,
  },
  'project.upgraded': {
    label: 'Project complimentary upgrade',
    folder: 'Projects & Previews',
    when: 'When an admin gives a free complimentary upgrade on a project.',
    entityType: 'order',
    trigger: true,
    supportsScope: true,
    conditions: ALWAYS_ONLY,
  },
  'preview.updated': {
    label: 'Website preview updated or shared',
    folder: 'Projects & Previews',
    when: 'When a project website preview is configured, uploaded, shared, or cleaned up.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },

  // 3. Plans & Packages
  'plan.started': {
    label: 'Plan started',
    folder: 'Plans & Packages',
    when: 'When a monthly plan or package starts (admin start, client purchase, or after project completion).',
    entityType: 'order',
    trigger: true,
    canStop: true,
    supportsScope: true,
    supportsLimit: true,
    conditions: PACKAGE_CONDITIONS,
    defaultStopOn: ['upload.completed', 'payment.received'],
  },
  'plan.purchased': {
    label: 'Service plan purchased',
    folder: 'Plans & Packages',
    when: 'When a client purchases a service plan from the portal.',
    entityType: 'order',
    trigger: true,
    supportsScope: true,
    supportsLimit: true,
    conditions: PACKAGE_CONDITIONS,
    defaultStopOn: ['payment.received'],
  },
  'package.purchased': {
    label: 'Package purchased',
    folder: 'Plans & Packages',
    when: 'When a client buys a sales package.',
    entityType: 'order',
    trigger: true,
    supportsScope: true,
    supportsLimit: true,
    conditions: PACKAGE_CONDITIONS,
    defaultStopOn: ['upload.completed', 'payment.received'],
  },
  'plan.requested': {
    label: 'Plan requested',
    folder: 'Plans & Packages',
    when: 'When a visitor or client requests a plan or checks a plan/package quote.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'plan.work_updated': {
    label: 'Plan work update added',
    folder: 'Plans & Packages',
    when: 'When an admin posts a work update or changes release mode on an active plan.',
    entityType: 'order',
    trigger: true,
    supportsScope: true,
    supportsLimit: true,
    conditions: ALWAYS_ONLY,
  },
  'plan.closed': {
    label: 'Plan closed / renewal stopped',
    folder: 'Plans & Packages',
    when: 'When a client or system stops automatic renewal of a service plan.',
    entityType: 'order',
    trigger: true,
    canStop: true,
    supportsScope: true,
    conditions: ALWAYS_ONLY,
  },
  'package.start_requested': {
    label: 'Package start requested',
    folder: 'Plans & Packages',
    when: 'When a client requests the team to start their purchased package.',
    entityType: 'package_start',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
    defaultStopOn: ['start_request.closed', 'project.created'],
  },
  'start_request.closed': {
    label: 'Start request closed',
    folder: 'Plans & Packages',
    when: 'When the team closes or fulfills a package/reservation start request.',
    entityType: 'none',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'catalogue.plan_updated': {
    label: 'Plan or sales package catalogue updated',
    folder: 'Plans & Packages',
    when: 'When an admin creates, edits, pauses, links, retires, or deletes a plan or sales package.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },

  // 4. Data Uploads & Documents
  'upload.completed': {
    label: 'Update request / upload completed',
    folder: 'Data Uploads & Documents',
    when: 'When a client uploads files (portal or external link) or submits an update request.',
    entityType: 'none',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'plan.upload_updated': {
    label: 'Plan upload status changed',
    folder: 'Data Uploads & Documents',
    when: 'When an admin changes upload status (in progress, completed, rejected), creates/revokes an upload link, or adds a client document.',
    entityType: 'order',
    trigger: true,
    supportsScope: true,
    supportsLimit: true,
    conditions: ALWAYS_ONLY,
  },

  // 5. Leads, Offers & Reservations
  'lead.created': {
    label: 'Lead created',
    folder: 'Leads, Offers & Reservations',
    when: 'When a lead is created, edited, or deleted in the admin panel.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'lead.proposal': {
    label: 'Proposal sent',
    folder: 'Leads, Offers & Reservations',
    when: 'When an admin uploads a proposal or sends a proposal on WhatsApp to a lead.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'lead.message': {
    label: 'Message sent to lead',
    folder: 'Leads, Offers & Reservations',
    when: 'When an admin sends a direct message to a lead.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'lead.final_message_started': {
    label: 'Final message started',
    folder: 'Leads, Offers & Reservations',
    when: 'When a final follow-up message is prepared or decided for a negative/unresponsive lead.',
    entityType: 'final_message',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
    defaultStopOn: ['final_message.stopped', 'whatsapp.ad_received'],
  },
  'final_message.stopped': {
    label: 'Final message stopped',
    folder: 'Leads, Offers & Reservations',
    when: 'When a lead final message follow-up is stopped.',
    entityType: 'none',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'reservation.created': {
    label: 'Offer reserved',
    folder: 'Leads, Offers & Reservations',
    when: 'When a visitor or customer reserves a limited-time offer.',
    entityType: 'reservation',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
    defaultStopOn: ['payment.received', 'reservation.start_requested', 'reservation.expired'],
  },
  'reservation.extended': {
    label: 'Reservation extended',
    folder: 'Leads, Offers & Reservations',
    when: 'When an admin extends the deadline of an offer reservation.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'reservation.start_requested': {
    label: 'Reservation start requested',
    folder: 'Leads, Offers & Reservations',
    when: 'When a customer clicks Start my project on a reserved offer.',
    entityType: 'reservation',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
    defaultStopOn: ['start_request.closed', 'project.created'],
  },
  'reservation.expired': {
    label: 'Reservation expired',
    folder: 'Leads, Offers & Reservations',
    when: 'When an offer reservation countdown expires without payment.',
    entityType: 'none',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'offer.target_updated': {
    label: 'Offer target or stage updated',
    folder: 'Leads, Offers & Reservations',
    when: 'When an admin adds people to an offer, updates their offer stage/behaviour, or marks them bought.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },

  // 6. Login, Profile, Accounts & Support
  'user.signed_in': {
    label: 'User login or role switch',
    folder: 'Login, Profile, Accounts & Support',
    when: 'When a user signs in, uses guest login, or switches active role.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'user.signed_up': {
    label: 'User sign up, OTP or profile updated',
    folder: 'Login, Profile, Accounts & Support',
    when: 'When someone signs up, verifies/resends OTP, sets password, or updates their profile.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'client.account_created': {
    label: 'Client account created',
    folder: 'Login, Profile, Accounts & Support',
    when: 'When a lead is converted into a client or an admin creates a team/client account.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'account.updated': {
    label: 'Account status, password reset or role granted',
    folder: 'Login, Profile, Accounts & Support',
    when: 'When an admin resets a client password, changes account active/blocked status, or grants a role.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'ticket.updated': {
    label: 'Support ticket opened or replied',
    folder: 'Login, Profile, Accounts & Support',
    when: 'When a client opens a support ticket or a client/admin replies to a ticket.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },

  // 7. Website Content, Products, Broadcast & Settings
  'website.content_updated': {
    label: 'Website banner, ad, slide or popup changed',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When an admin uploads, edits, or deletes a website banner, advertisement, guest slide, or welcome popup.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'product.updated': {
    label: 'Store product or category changed',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When an admin adds, updates, deletes, hides, unhides a product/category or changes base prices.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'broadcast.sent': {
    label: 'Broadcast sent',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When an admin sends/retries a broadcast or manages broadcast templates/media.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
    defaultStopOn: ['whatsapp.ad_received'],
  },
  'whatsapp.ad_received': {
    label: 'WhatsApp ad message received',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When an incoming WhatsApp message matches the Auto Reply ad text.',
    entityType: 'none',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'subscription.updated': {
    label: 'Website subscription confirmation or management',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When a website subscription message draft or newsletter subscription is updated.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'trash.updated': {
    label: 'Record moved to trash, restored or deleted',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When an admin deletes an order, moves a client to Trash, restores from Trash, or purges permanently.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'settings.updated': {
    label: 'Admin, invoice or communication settings changed',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When an admin updates portal/invoice settings, templates, email policies, auto-reply, WhatsApp, or reminder controls.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
  'plan.expired': {
    label: 'Plan / Package Expired',
    folder: 'Plans & Packages',
    when: 'When a monthly plan or package expires (can filter by remaining portal upload limit).',
    entityType: 'order',
    trigger: true,
    canStop: true,
    supportsScope: true,
    supportsLimit: true,
    conditions: PACKAGE_CONDITIONS,
    defaultStopOn: ['payment.received'],
  },
  'comment.posted': {
    label: 'Website Comment / Review Posted',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When a visitor or client posts a new comment or review on the website.',
    entityType: 'none',
    trigger: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
    defaultStopOn: ['comment.approved'],
  },
  'comment.approved': {
    label: 'Comment Approved / Moderated',
    folder: 'Website Content, Products, Broadcast & Settings',
    when: 'When an admin approves or moderates a website comment.',
    entityType: 'none',
    trigger: true,
    canStop: true,
    supportsScope: false,
    conditions: ALWAYS_ONLY,
  },
};
const enabled = () => process.env.ACTION_RULES_ENABLED === 'true';

// Records one action. Inside a session the event commits or aborts with the business change.
// `key` makes it idempotent: the same action on the same record is recorded once.
// With ACTION_RULES_ENABLED off nothing is written, so existing flows are unchanged.
async function emitAction(action, { key, entityId, clientId = null, leadId = null, orderId = null, matchKeys = [], details = {}, occurredAt = new Date() }, { session = null } = {}) {
  if (!enabled()) return false;
  if (!ACTIONS[action]) throw new Error(`Unknown action ${action}`);
  let scope = null;
  try { scope = require('./emailController').getActiveRequestScope?.() || null; } catch { scope = null; }
  const nextDetails = { ...details };
  if (scope && !scope.system && scope.req) {
    if (!nextDetails.originSurface) {
      try {
        const matched = require('./communicationActions').matchCatalogAction?.(scope.req.method, scope.req.originalUrl);
        if (matched?.surface) nextDetails.originSurface = matched.surface;
      } catch { /* ignore */ }
    }
    if (scope.syncReviewedTemplates?.length && !nextDetails.syncReviewedTemplates) {
      nextDetails.syncReviewedTemplates = [...scope.syncReviewedTemplates];
    }
    if (Array.isArray(scope.emittedActions) && !scope.emittedActions.includes(action)) scope.emittedActions.push(action);
    if (Array.isArray(scope.emittedEventKeys) && !scope.emittedEventKeys.includes(key)) scope.emittedEventKeys.push(key);
  }
  const doc = { action, entityId, clientId, leadId, orderId, matchKeys, details: nextDetails, occurredAt, status: 'new' };
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
  details: {
    invoiceType: invoice.invoiceType,
    amount: invoice.amount,
    dueDate: invoice.dueDate,
    invoiceNumber: invoice.invoiceNumber,
    ...(invoice.invoiceType === 'plan_renewal' ? { originSurface: 'System' } : {}),
  },
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
  const clientId = record.userId?._id || record.userId || null;
  const orderId = record.updatePlanId?._id || record.updatePlanId || null;
  const matchKeys = [
    `upload:${id(record._id)}`,
    ...(orderId ? [`order:${id(orderId)}`] : []),
    ...(clientId ? [`client:${id(clientId)}`] : []),
  ];
  return emitAction('upload.completed', {
    key: `upload.completed:${id(record._id)}`,
    entityId: record._id,
    clientId,
    orderId,
    matchKeys,
    details: { title: record.title || record.subject || '' },
  });
};

const orderUpiPending = (order, { txId = null } = {}) => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('order.upi_pending', {
    key: txId ? `order.upi_pending:${id(order._id)}:${id(txId)}` : `order.upi_pending:${id(order._id)}`,
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

const projectStepUpdated = (order, nodeOrId) => {
  if (!order?._id) return Promise.resolve(false);
  const nodeId = typeof nodeOrId === 'object' && nodeOrId !== null
    ? (nodeOrId.nodeId || nodeOrId._id || order.projectProgress || 'step')
    : (nodeOrId || order.projectProgress || 'step');
  return emitAction('project.step_updated', {
    key: `project.step_updated:${id(order._id)}:${id(nodeId)}:${Number(order.projectProgress || 0)}`,
    entityId: order._id,
    clientId: order.userId?._id || order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
    details: { progress: Number(order.projectProgress || 0), originSurface: 'Admin' },
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

const planExpired = order => {
  if (!order?._id) return Promise.resolve(false);
  return emitAction('plan.expired', {
    key: `plan.expired:${id(order._id)}:${order.serviceCurrentCycleNumber || 1}`,
    entityId: order._id,
    clientId: order.userId || null,
    orderId: order._id,
    matchKeys: [`order:${id(order._id)}`],
    details: { remainingLimit: order.currentMonthUpdatesRemaining ?? null },
  });
};

const commentPosted = ({ commentId, blogId = '', userId = null, userName = '', status = 'pending' } = {}) => {
  if (!commentId) return Promise.resolve(false);
  const mongoose = require('mongoose');
  const entityId = mongoose.Types.ObjectId.isValid(String(commentId))
    ? new mongoose.Types.ObjectId(String(commentId))
    : new mongoose.Types.ObjectId();
  const clientId = userId && mongoose.Types.ObjectId.isValid(String(userId)) ? userId : null;
  return emitAction('comment.posted', {
    key: `comment.posted:${String(commentId)}`,
    entityId,
    clientId,
    matchKeys: [`comment:${String(commentId)}`],
    details: { commentId: String(commentId), blogId: String(blogId || ''), userName: String(userName || ''), status: String(status || '') },
  });
};

const commentApproved = ({ commentId, blogId = '', status = 'visible' } = {}) => {
  if (!commentId) return Promise.resolve(false);
  const mongoose = require('mongoose');
  const entityId = mongoose.Types.ObjectId.isValid(String(commentId))
    ? new mongoose.Types.ObjectId(String(commentId))
    : new mongoose.Types.ObjectId();
  return emitAction('comment.approved', {
    key: `comment.approved:${String(commentId)}`,
    entityId,
    matchKeys: [`comment:${String(commentId)}`],
    details: { commentId: String(commentId), blogId: String(blogId || ''), status: String(status || '') },
  });
};

const STOP_CHOICES = Object.entries(ACTIONS)
  .filter(([, meta]) => meta.canStop)
  .map(([key, meta]) => ({ key, label: meta.label }));

module.exports = {
  FOLDERS,
  STOP_CHOICES,
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
  planExpired,
  commentPosted,
  commentApproved,
};
