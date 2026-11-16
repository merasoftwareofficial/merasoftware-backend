const Override = require('../models/communicationActionOverrideModel');
const ActionRule = require('../models/communicationActionRuleModel');
const { EmailControl } = require('../models/emailControlModel');
const { ACTIONS: ACTION_CATALOG, SURFACES } = require('./communicationActionCatalog');
const { ACTIONS: TRIGGER_ACTIONS } = require('./actionEvents');
const { TEXT_BY_ID } = require('./communicationActionText');
const { CATEGORIES } = require('./communicationCategories');
const { byKey: EMAIL_BY_KEY } = require('./emailCatalog');
const { readPackages } = require('./salesPackages');

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
  A60: { templates: ['lead.finalMessage'], reminders: [{ panel: 'final-message', label: 'Final Message' }] },
  A62: { templates: ['sendClientAccountCreatedEmail'] },
  A63: { templates: ['lead.proposal'] },
  A64: { templates: ['lead.proposal'] },
  A65: { templates: ['lead.finalMessage'], reminders: [{ panel: 'final-message', label: 'Final Message' }] },
  A66: { templates: ['lead.finalMessage'], reminders: [{ panel: 'final-message', label: 'Final Message' }] },
  A67: { reminders: [{ panel: 'final-message', label: 'Final Message (stop)' }] },
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
  B05: { templates: ['broadcast.manual'] },
  B06: { templates: ['broadcast.manual'] },
  B07: { templates: ['website.subscription.confirm', 'website.subscription.manage'] },
  B21: { templates: ['lead.finalMessage'], reminders: [{ panel: 'final-message', label: 'Final Message' }] },
  B35: { templates: ['offer.reserved'], reminders: [{ panel: 'reservation', label: 'Reservation countdown' }] },
  B36: { templates: ['offer.reservation.extended'] },
  B37: { templates: ['offer.start.request.admin', 'offer.start.request.received'], reminders: [{ panel: 'reservation', label: 'Team start alerts' }] },
  B39: { templates: ['package.start.request.admin', 'package.start.request.received'], reminders: [{ panel: 'reminders', label: 'Package start alerts' }] },
  B41: { templates: ['package.purchase.admin', 'package.purchase.received', 'plan.started', 'plan.purchase.admin', 'plan.payment.submitted'] },
};

function builtInFor(actionId, policyByEvent = null) {
  const entry = BUILTIN_BY_ACTION_ID[actionId];
  if (!entry) return { templates: [], reminders: [] };
  const templates = (entry.templates || []).map(key => {
    const meta = EMAIL_BY_KEY.get(key);
    const mode = policyByEvent?.get(key);
    return {
      event: key,
      label: meta?.label || key,
      app: meta?.application || 'portal',
      panel: key === 'broadcast.manual' ? 'broadcast' : 'email-templates',
      ...(mode ? { mode } : {}),
      active: mode !== 'off',
    };
  });
  return { templates, reminders: entry.reminders || [] };
}

// Maps Actions-list IDs (Reminder-mapping.md §A) to backend action-rule trigger keys.
const TRIGGER_BY_ACTION_ID = {
  A29: 'plan.started',
  A51: 'plan.started',
  A105: 'plan.started',
  A104: 'invoice.created',
  B41: 'invoice.created',
  A43: 'payment.received',
  A83: 'payment.received',
  A89: 'payment.received',
  A90: 'payment.received',
  A91: 'payment.received',
  A110: 'payment.received',
  A114: 'project.completed',
  A115: 'project.completed',
  A116: 'project.completed',
  A117: 'project.completed',
  A118: 'project.completed',
  A119: 'project.completed',
  A120: 'project.completed',
  B05: 'broadcast.sent',
  B49: 'whatsapp.ad_received',
};

const CATEGORY_MAX = 60;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// One action as the page shows it: the catalog row, with the owner's saved changes on top.
function merge(base, override, rules = [], policyByEvent = null) {
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
    builtIn: builtInFor(base.id, policyByEvent),
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

async function list() {
  const [overrides, allRules, catalogue, policies] = await Promise.all([
    Override.find().lean(),
    ActionRule.find().sort({ createdAt: 1 }).lean(),
    readPackages().catch(() => []),
    EmailControl.find().select('event mode').lean().catch(() => []),
  ]);
  const policyByEvent = new Map(policies.map(p => [p.event, p.mode]));
  const byId = new Map(overrides.map(item => [item.actionId, item]));
  const known = new Set(CATEGORIES.map(item => item.name));
  const extra = [...new Set(overrides.map(o => o.category).filter(name => name && !known.has(name)))];
  const categories = [...CATEGORIES, ...extra.map(name => ({ name, meaning: '' }))];
  const rulesFor = baseId => {
    const triggerKey = TRIGGER_BY_ACTION_ID[baseId] || null;
    return allRules.filter(r => r.actionId === baseId || (triggerKey && !r.actionId && r.action === triggerKey));
  };
  const packages = (Array.isArray(catalogue) ? catalogue : [])
    .filter(p => p && p.slug)
    .map(p => ({ slug: p.slug, name: p.name || p.slug }));
  return { actions: ACTION_CATALOG.map(base => merge(base, byId.get(base.id), rulesFor(base.id), policyByEvent)), surfaces: SURFACES, categories, packages };
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

module.exports = { list, update, merge, validatePatch, clean };
