const Override = require('../models/communicationActionOverrideModel');
const ActionRule = require('../models/communicationActionRuleModel');
const { ACTIONS: ACTION_CATALOG, SURFACES } = require('./communicationActionCatalog');
const { ACTIONS: TRIGGER_ACTIONS } = require('./actionEvents');
const { TEXT_BY_ID } = require('./communicationActionText');
const { CATEGORIES } = require('./communicationCategories');
const { readPackages } = require('./salesPackages');

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
  B49: 'whatsapp.ad_received',
};

const CATEGORY_MAX = 60;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// One action as the page shows it: the catalog row, with the owner's saved changes on top.
function merge(base, override, rules = []) {
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
  const [overrides, allRules, catalogue] = await Promise.all([
    Override.find().lean(),
    ActionRule.find().sort({ createdAt: 1 }).lean(),
    readPackages().catch(() => []),
  ]);
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
  return { actions: ACTION_CATALOG.map(base => merge(base, byId.get(base.id), rulesFor(base.id))), surfaces: SURFACES, categories, packages };
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
