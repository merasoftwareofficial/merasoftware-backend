const Override = require('../models/communicationActionOverrideModel');
const ActionRule = require('../models/communicationActionRuleModel');
const { EmailPolicy } = require('../models/emailControlModel');
const { ACTIONS: ACTION_CATALOG, SURFACES } = require('./communicationActionCatalog');
const { ACTIONS: TRIGGER_ACTIONS, FOLDERS, STOP_CHOICES } = require('./actionEvents');
const { getAutomationCatalog } = require('./automationCatalog');
const { TEXT_BY_ID } = require('./communicationActionText');
const { CATEGORIES } = require('./communicationCategories');
const { byKey: EMAIL_BY_KEY, isCustomerTriggered } = require('./emailCatalog');
const { readPackages } = require('./salesPackages');
const Product = require('../models/productModel');

async function loadScopePackages() {
  const [catalogue, plans] = await Promise.all([
    readPackages().catch(() => []),
    Product.find({ category: 'service_plan', isServicePlan: true, retiredAt: null, archivedAt: null })
      .select('_id serviceName')
      .sort({ serviceName: 1 })
      .lean()
      .catch(() => []),
  ]);
  const pkgItems = (Array.isArray(catalogue) ? catalogue : [])
    .filter(p => p && (p.slug || p.id))
    .map(p => ({ slug: p.slug || p.id, name: p.name || p.slug || p.id }));
  const planItems = (Array.isArray(plans) ? plans : [])
    .filter(p => p && p._id)
    .map(p => ({ slug: `plan:${String(p._id)}`, name: `Plan: ${p.serviceName || String(p._id)}` }));
  return [...pkgItems, ...planItems];
}

// Maps Actions-list IDs (Reminder-mapping.md §A) to built-in templates and legacy reminders/automations.
// Template labels and portal/website app routing come from emailCatalog (SSOT).
const BUILTIN_BY_ACTION_ID = {
  A13: { templates: ['sendUpdateRequestNotification', 'sendUserConfirmation'] },
  A15: { templates: ['plan.request.admin', 'plan.request.received'] },
  A26: { templates: ['sendUpdateRequestNotification', 'sendUserConfirmation'] },
  A29: { templates: ['sendProjectCreatedEmail', 'plan.started'] },
  A39: { templates: ['plan.request.admin', 'plan.request.received'] },
  A44: { templates: ['sendProjectCancellationEmail'] },
  A45: { templates: ['project.upgrade.offer', 'project.upgrade.started', 'project.upgrade.completed'] },
  A51: { templates: ['plan.started'] },
  A53: { templates: ['plan.work_update'] },
  A54: { templates: ['plan.upload.in_progress', 'plan.upload.completed', 'plan.upload.rejected'] },
  A58: { templates: ['lead.created'] },
  A60: { templates: ['lead.finalMessage'] },
  A62: { templates: ['sendClientAccountCreatedEmail'] },
  A63: { templates: ['lead.proposal'] },
  A64: { templates: ['lead.proposal'] },
  A65: { templates: ['lead.finalMessage'] },
  A66: { templates: ['lead.finalMessage'] },
  A67: {},
  A68: { templates: ['lead.message'] },
  A82: { templates: ['sendUpdateRequestNotification', 'sendUserConfirmation'] },
  A91: { templates: ['plan.payment.received'] },
  A92: { templates: ['plan.payment.rejected'] },
  A104: { templates: ['sendAdminUPIPendingNotification'] },
  A105: { templates: ['plan.started', 'plan.purchase.admin', 'plan.payment.submitted'] },
  A111: { templates: ['invoice.project'] },
  A112: { templates: ['sendMonthlyInvoiceEmail'] },
  A113: { templates: ['invoice.reminder'] },
  A114: { templates: ['sendProjectUpdateEmail', 'plan.started'] },
  A115: { templates: ['sendProjectUpdateEmail', 'plan.started'] },
  A116: { templates: ['sendProjectUpdateEmail', 'plan.started'] },
  A117: { templates: ['sendProjectUpdateEmail', 'plan.started'] },
  A118: { templates: ['sendProjectUpdateEmail', 'plan.started'] },
  A119: { templates: ['sendProjectUpdateEmail', 'plan.started'] },
  A120: { templates: ['sendProjectUpdateEmail', 'plan.started'] },
  B07: { templates: ['website.subscription.confirm', 'website.subscription.manage'] },
  B21: { templates: ['lead.finalMessage'] },
  B35: { templates: ['offer.reserved'] },
  B36: { templates: ['offer.reservation.extended'] },
  B37: { templates: ['offer.start.request.admin', 'offer.start.request.received'] },
  B39: { templates: ['package.start.request.admin', 'package.start.request.received'] },
  B41: { templates: ['package.purchase.admin', 'package.purchase.received', 'plan.started', 'plan.purchase.admin', 'plan.payment.submitted'] },
};

function builtInFor(actionId, policyByEvent = null, migratedTemplateEvents = null) {
  const entry = BUILTIN_BY_ACTION_ID[actionId];
  if (!entry) return { templates: [], reminders: [] };
  const templates = (entry.templates || [])
    .filter(key => !migratedTemplateEvents || !migratedTemplateEvents.has(key))
    .map(key => {
    const meta = EMAIL_BY_KEY.get(key);
    let mode;
    if (policyByEvent) {
      const saved = policyByEvent.get(key);
      if (saved === 'off') mode = 'off';
      else if (isCustomerTriggered(key)) mode = saved === 'auto' ? 'auto' : 'off';
      else if (meta?.trigger === 'system') mode = 'auto';
      else mode = saved || 'review';
    }
    return {
      event: key,
      label: meta?.label || key,
      app: meta?.application || 'portal',
      panel: key === 'broadcast.manual' ? 'broadcast' : 'email-templates',
      ...(mode ? { mode } : {}),
      active: mode ? mode !== 'off' : true,
    };
  });
  return { templates, reminders: entry.reminders || [] };
}

// Maps all 179 Actions-list IDs (A01-A130, B01-B49) to backend Work Group trigger keys (SSOT).
const TRIGGER_BY_ACTION_ID = {
  // Admin & communication settings
  A01: 'settings.updated',
  A02: 'settings.updated',
  A55: 'settings.updated',
  A56: 'settings.updated',
  A57: 'settings.updated',
  A59: 'settings.updated',
  B08: 'settings.updated',
  B09: 'settings.updated',
  B10: 'settings.updated',
  B11: 'settings.updated',
  B12: 'settings.updated',
  B13: 'settings.updated',
  B14: 'settings.updated',
  B15: 'settings.updated',
  B16: 'settings.updated',
  B17: 'settings.updated',
  B18: 'settings.updated',
  B19: 'settings.updated',
  B20: 'settings.updated',
  B22: 'settings.updated',
  B24: 'settings.updated',
  B25: 'settings.updated',
  B27: 'settings.updated',
  B28: 'settings.updated',
  B29: 'settings.updated',
  B30: 'settings.updated',
  B43: 'settings.updated',
  B44: 'settings.updated',
  B45: 'settings.updated',
  B46: 'settings.updated',
  B47: 'settings.updated',
  B48: 'settings.updated',

  // Website preview
  A03: 'preview.updated',
  A04: 'preview.updated',
  A05: 'preview.updated',
  A06: 'preview.updated',
  A07: 'preview.updated',
  A08: 'preview.updated',

  // Data uploads & documents
  A11: 'upload.completed',
  A12: 'upload.completed',
  A13: 'upload.completed',
  A14: 'upload.completed',
  A23: 'upload.completed',
  A24: 'upload.completed',
  A25: 'upload.completed',
  A26: 'upload.completed',
  A27: 'upload.completed',
  A82: 'upload.completed',
  A21: 'plan.upload_updated',
  A22: 'plan.upload_updated',
  A40: 'plan.upload_updated',
  A54: 'plan.upload_updated',

  // Plans & packages
  A15: 'plan.requested',
  A36: 'plan.requested',
  A37: 'plan.requested',
  A38: 'plan.requested',
  A39: 'plan.requested',
  A50: 'plan.requested',
  A106: 'plan.requested',
  B40: 'plan.requested',
  A20: 'catalogue.plan_updated',
  A30: 'catalogue.plan_updated',
  A31: 'catalogue.plan_updated',
  A32: 'catalogue.plan_updated',
  A33: 'catalogue.plan_updated',
  A34: 'catalogue.plan_updated',
  A35: 'catalogue.plan_updated',
  A48: 'catalogue.plan_updated',
  A49: 'catalogue.plan_updated',
  A96: 'catalogue.plan_updated',
  A97: 'catalogue.plan_updated',
  A98: 'catalogue.plan_updated',
  A29: 'plan.started',
  A51: 'plan.started',
  A105: 'plan.started',
  A52: 'plan.work_updated',
  A53: 'plan.work_updated',
  A109: 'plan.closed',
  B39: 'package.start_requested',
  B26: 'start_request.closed',
  B42: 'start_request.closed',

  // Projects
  A09: 'project.step_updated',
  A10: 'project.step_updated',
  A44: 'project.cancelled',
  A45: 'project.upgraded',
  A108: 'project.created',
  A114: 'project.step_updated',
  A115: 'project.step_updated',
  A116: 'project.step_updated',
  A117: 'project.step_updated',
  A118: 'project.step_updated',
  A119: 'project.step_updated',
  A120: 'project.step_updated',

  // Payments, orders & wallet
  A18: 'wallet.recharged',
  A46: 'wallet.recharged',
  A43: 'payment.received',
  A83: 'payment.received',
  A89: 'payment.received',
  A90: 'payment.received',
  A91: 'payment.received',
  A110: 'payment.received',
  A86: 'bank.account_updated',
  A87: 'bank.account_updated',
  A88: 'bank.account_updated',
  A92: 'plan.payment_rejected',
  A104: 'invoice.created',
  A107: 'invoice.created',
  B41: 'invoice.created',
  A111: 'invoice.resent',
  A112: 'invoice.resent',
  A113: 'invoice.manual_reminder',

  // Leads, offers & reservations
  A58: 'lead.created',
  A60: 'lead.created',
  A61: 'trash.updated',
  A63: 'lead.proposal',
  A64: 'lead.proposal',
  A65: 'lead.final_message_started',
  A66: 'lead.final_message_started',
  B21: 'lead.final_message_started',
  A67: 'final_message.stopped',
  A68: 'lead.message',
  B23: 'reservation.created',
  B35: 'reservation.created',
  B38: 'reservation.created',
  B36: 'reservation.extended',
  B37: 'reservation.start_requested',
  B31: 'offer.target_updated',
  B32: 'offer.target_updated',
  B33: 'offer.target_updated',
  B34: 'offer.target_updated',

  // Login, profile, accounts & support
  A16: 'user.signed_up',
  A72: 'user.signed_up',
  A73: 'user.signed_up',
  A74: 'user.signed_up',
  A76: 'user.signed_up',
  A77: 'user.signed_up',
  A78: 'user.signed_up',
  A17: 'user.signed_in',
  A19: 'user.signed_in',
  A75: 'user.signed_in',
  A41: 'account.updated',
  A42: 'account.updated',
  A79: 'account.updated',
  A80: 'account.updated',
  A62: 'client.account_created',
  A81: 'client.account_created',
  A84: 'ticket.updated',
  A85: 'ticket.updated',

  // Website content, products, broadcast & trash
  A28: 'trash.updated',
  A69: 'trash.updated',
  A70: 'trash.updated',
  A71: 'trash.updated',
  A47: 'product.updated',
  A93: 'product.updated',
  A94: 'product.updated',
  A95: 'product.updated',
  A99: 'product.updated',
  A100: 'product.updated',
  A101: 'product.updated',
  A102: 'product.updated',
  A103: 'product.updated',
  A121: 'website.content_updated',
  A122: 'website.content_updated',
  A123: 'website.content_updated',
  A124: 'website.content_updated',
  A125: 'website.content_updated',
  A126: 'website.content_updated',
  A127: 'website.content_updated',
  A128: 'website.content_updated',
  A129: 'website.content_updated',
  A130: 'website.content_updated',
  B01: 'broadcast.sent',
  B02: 'broadcast.sent',
  B03: 'broadcast.sent',
  B04: 'broadcast.sent',
  B05: 'broadcast.sent',
  B06: 'broadcast.sent',
  B07: 'subscription.updated',
  B49: 'whatsapp.ad_received',
};

const CATEGORY_MAX = 60;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// One action as the page shows it: the catalog row, with the owner's saved changes on top.
function merge(base, override, rules = [], policyByEvent = null, migratedTemplateEvents = null) {
  const o = override || {};
  const text = TEXT_BY_ID[base.id] || { title: base.endpoint, what: '', when: '' };
  const triggerKey = TRIGGER_BY_ACTION_ID[base.id] || null;
  const triggerMeta = triggerKey ? TRIGGER_ACTIONS[triggerKey] : null;
  return {
    id: base.id,
    title: text.title,
    what: text.what,
    when: text.when,
    method: base.method,
    endpoint: base.endpoint,
    note: base.note,
    surface: o.surface || base.surface,
    category: o.category || base.category,
    archived: !!o.archived,
    deleted: !!o.deleted,
    changed: !!override,
    triggerKey,
    supportsScope: !!triggerMeta?.supportsScope,
    conditions: triggerMeta?.conditions || [{ key: 'anytime', label: 'Anytime (always)' }],
    builtIn: builtInFor(base.id, policyByEvent, migratedTemplateEvents),
    rules,
  };
}

// Checks a change request. Returns only the fields to save; throws a 400 for bad input.
function validatePatch(body = {}) {
  const patch = {};
  if (body.surface !== undefined) {
    if (!SURFACES.includes(body.surface)) fail('Choose a valid surface: Admin, Client, Website or System.');
    patch.surface = body.surface;
  }
  if (body.category !== undefined) {
    const category = clean(body.category, CATEGORY_MAX);
    if (!category) fail('Category cannot be empty.');
    patch.category = category;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') fail('archived must be true or false.');
    patch.archived = body.archived;
  }
  if (body.deleted !== undefined) {
    if (typeof body.deleted !== 'boolean') fail('deleted must be true or false.');
    patch.deleted = body.deleted;
  }
  return patch;
}

async function list(options = {}) {
  if (options?.view === 'catalog') {
    const packages = await loadScopePackages();
    const triggers = [];
    for (const [triggerKey, meta] of Object.entries(TRIGGER_ACTIONS)) {
      if (!meta?.trigger) continue;
      triggers.push({
        triggerKey,
        label: meta.label,
        folder: meta.folder || 'Other',
        when: meta.when || '',
        entityType: meta.entityType || 'none',
        supportsScope: !!meta.supportsScope,
        supportsProgress: !!meta.supportsProgress,
        supportsLimit: !!meta.supportsLimit,
        canStop: !!meta.canStop,
        defaultStopOn: meta.defaultStopOn || [],
        conditions: meta.conditions || [{ key: 'anytime', label: 'Anytime (always)' }],
        origins: [],
      });
    }
    const { conditions, systemActions } = getAutomationCatalog();
    return { triggers, folders: FOLDERS, packages, conditions, systemActions };
  }
  const [overrides, allRules, packages, policies] = await Promise.all([
    Override.find().lean(),
    ActionRule.find().sort({ createdAt: 1 }).lean(),
    loadScopePackages(),
    EmailPolicy.find().select('event mode').lean().catch(() => []),
  ]);
  const policyByEvent = new Map(policies.map(p => [p.event, p.mode]));
  const byId = new Map(overrides.map(item => [item.actionId, item]));
  const known = new Set(CATEGORIES.map(item => item.name));
  const extra = [...new Set(overrides.map(o => o.category).filter(name => name && !known.has(name)))];
  const categories = [...CATEGORIES, ...extra.map(name => ({ name, meaning: '' }))];
  const migratedTemplateEvents = new Set(
    allRules
      .filter(r => typeof r.migratedFrom === 'string' && r.migratedFrom.startsWith('template:'))
      .map(r => r.migratedFrom.slice('template:'.length)),
  );
  const rulesFor = baseId => {
    const triggerKey = TRIGGER_BY_ACTION_ID[baseId] || null;
    return allRules.filter(r =>
      r.actionId === baseId ||
      (triggerKey && r.action === triggerKey && (!r.actionId || String(r.migratedFrom || '').startsWith('template:'))),
    );
  };
  const actions = ACTION_CATALOG.map(base => merge(base, byId.get(base.id), rulesFor(base.id), policyByEvent, migratedTemplateEvents));
  const triggers = buildTriggers(actions, allRules);
  const { conditions, systemActions } = getAutomationCatalog();
  return { actions, triggers, folders: FOLDERS, stopChoices: STOP_CHOICES, surfaces: SURFACES, categories, packages, conditions, systemActions };
}

// Cross-flow & system origins that fire a trigger alongside its primary catalog mapping (SSOT).
const EXTRA_ORIGINS_BY_TRIGGER = {
  'invoice.created': [
    { id: 'A29', title: 'Admin creates unpaid project/package ("Customer will pay")', surface: 'Admin', method: 'POST', endpoint: '/api/admin/clients/:customerId/create-project' },
    { id: 'A51', title: 'Start a plan for a client', surface: 'Admin', method: 'POST', endpoint: '/api/admin/clients/:customerId/service-plans' },
    { id: 'A105', title: 'Buy a service plan', surface: 'Client', method: 'POST', endpoint: '/api/customer/service-plan-order' },
    { id: 'CRON-RENEW', title: 'Monthly plan renewal invoice generated', surface: 'System', method: 'CRON', endpoint: 'servicePlanRenewalCron' },
  ],
  'plan.started': [
    { id: 'B41', title: 'Buy a package (monthly/plan activation)', surface: 'Client', method: 'POST', endpoint: '/api/package-starts/purchase' },
  ],
  'project.created': [
    { id: 'A29', title: 'Admin creates a project', surface: 'Admin', method: 'POST', endpoint: '/api/admin/clients/:customerId/create-project' },
    { id: 'B41', title: 'Customer buys a one-time package', surface: 'Client', method: 'POST', endpoint: '/api/package-starts/purchase' },
  ],
  'package.purchased': [
    { id: 'B41', title: 'Customer buys a package', surface: 'Client', method: 'POST', endpoint: '/api/package-starts/purchase' },
  ],
  'plan.purchased': [
    { id: 'A105', title: 'Customer buys a service plan', surface: 'Client', method: 'POST', endpoint: '/api/customer/service-plan-order' },
  ],
  'order.upi_pending': [
    { id: 'A104', title: 'Customer creates UPI pending order', surface: 'Client', method: 'POST', endpoint: '/api/create-order' },
  ],
  'reservation.expired': [
    { id: 'CRON-RES', title: 'Offer reservation expired automatically', surface: 'System', method: 'CRON', endpoint: 'reservationClosure' },
  ],
  'project.step_updated': [
    { id: 'A114', title: 'Add a project step', surface: 'Admin', method: 'POST', endpoint: '/api/admin/projects/:orderId/nodes' },
    { id: 'A115', title: 'Prepare a message about a project step', surface: 'Admin', method: 'POST', endpoint: '/api/admin/projects/:orderId/nodes/message' },
    { id: 'A116', title: 'Edit a project step', surface: 'Admin', method: 'POST', endpoint: '/api/admin/projects/:orderId/nodes/edit' },
    { id: 'A117', title: 'Delete project steps', surface: 'Admin', method: 'POST', endpoint: '/api/admin/projects/:orderId/nodes/delete' },
    { id: 'A118', title: 'Restore project steps', surface: 'Admin', method: 'POST', endpoint: '/api/admin/projects/:orderId/nodes/restore' },
    { id: 'A119', title: 'Show or hide project steps', surface: 'Admin', method: 'POST', endpoint: '/api/admin/projects/:orderId/nodes/visibility' },
    { id: 'A120', title: 'Reset project steps', surface: 'Admin', method: 'POST', endpoint: '/api/admin/projects/:orderId/nodes/reset' },
  ],
  'subscription.updated': [
    { id: 'B07', title: 'Website newsletter/subscription form', surface: 'Website', method: 'POST', endpoint: '/api/newsletter/subscribe' },
  ],
};

// Groups actions by backend business trigger ("kaam") so the UI can manage one rule per outcome
// while showing every origin (Admin, Client, Website, System) that fires it.
function buildTriggers(actions, allRules) {
  const byTrigger = new Map();
  for (const actionRow of actions) {
    if (!actionRow.triggerKey || actionRow.deleted) continue;
    const list = byTrigger.get(actionRow.triggerKey) || [];
    list.push(actionRow);
    byTrigger.set(actionRow.triggerKey, list);
  }
  const triggers = [];
  for (const [triggerKey, meta] of Object.entries(TRIGGER_ACTIONS)) {
    if (!meta?.trigger) continue;
    const rows = byTrigger.get(triggerKey) || [];
    const seenOrigins = new Set();
    const origins = [];
    const pushOrigin = o => {
      const key = `${o.surface}:${o.id}:${o.title}`;
      if (seenOrigins.has(key)) return;
      seenOrigins.add(key);
      origins.push(o);
    };
    for (const row of rows) {
      pushOrigin({ id: row.id, title: row.title, surface: row.surface, method: row.method, endpoint: row.endpoint });
    }
    for (const extra of EXTRA_ORIGINS_BY_TRIGGER[triggerKey] || []) {
      pushOrigin(extra);
    }
    const seenTpl = new Set();
    const templates = [];
    for (const row of rows) {
      for (const tpl of row.builtIn?.templates || []) {
        if (seenTpl.has(tpl.event)) continue;
        seenTpl.add(tpl.event);
        templates.push(tpl);
      }
    }
    triggers.push({
      triggerKey,
      label: meta.label,
      folder: meta.folder || 'Other',
      when: meta.when || '',
      entityType: meta.entityType || 'none',
      supportsScope: !!meta.supportsScope,
      supportsProgress: !!meta.supportsProgress,
      supportsLimit: !!meta.supportsLimit,
      canStop: !!meta.canStop,
      defaultStopOn: meta.defaultStopOn || [],
      conditions: meta.conditions || [{ key: 'anytime', label: 'Anytime (always)' }],
      origins,
      rules: allRules.filter(r => r.action === triggerKey),
      builtIn: { templates, reminders: [] },
    });
  }
  return triggers;
}

const COMPILED_CATALOG_ROUTES = ACTION_CATALOG
  .filter(item => item.endpoint.startsWith('/api/'))
  .map(item => {
    const pattern = '^' + item.endpoint.replace(/:[^/]+/g, '[^/]+') + '$';
    return {
      ...item,
      triggerKey: TRIGGER_BY_ACTION_ID[item.id] || null,
      regex: new RegExp(pattern),
    };
  });

function matchCatalogAction(method, rawUrl) {
  const m = String(method || '').toUpperCase();
  const cleanPath = String(rawUrl || '').split('?')[0].replace(/\/+$/, '') || '/';
  return COMPILED_CATALOG_ROUTES.find(item => item.method === m && item.regex.test(cleanPath)) || null;
}

async function update(actionId, body, userId) {
  const base = ACTION_CATALOG.find(action => action.id === actionId);
  if (!base) fail('Unknown action.', 404);
  if (body.reset === true) {
    await Override.deleteOne({ actionId });
    return merge(base, null);
  }
  const patch = validatePatch(body);
  if (!Object.keys(patch).length) fail('Nothing to change.');
  const saved = await Override.findOneAndUpdate(
    { actionId },
    { $set: { ...patch, updatedBy: userId } },
    { upsert: true, new: true, runValidators: true },
  ).lean();
  return merge(base, saved);
}

module.exports = { list, update, merge, validatePatch, clean, TRIGGER_BY_ACTION_ID, matchCatalogAction };
