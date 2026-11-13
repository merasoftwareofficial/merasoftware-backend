const Override = require('../models/communicationActionOverrideModel');
const { ACTIONS, SURFACES } = require('./communicationActionCatalog');

const CATEGORY_MAX = 60;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// One action as the page shows it: the catalog row, with the owner's saved changes on top.
function merge(base, override) {
  const o = override || {};
  return {
    id: base.id,
    method: base.method,
    endpoint: base.endpoint,
    note: base.note,
    surface: o.surface || base.surface,
    category: o.category || base.category,
    archived: !!o.archived,
    deleted: !!o.deleted,
    changed: !!override,
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
  const overrides = await Override.find().lean();
  const byId = new Map(overrides.map(item => [item.actionId, item]));
  const categories = [...new Set([...ACTIONS.map(a => a.category), ...overrides.map(o => o.category).filter(Boolean)])].sort();
  return { actions: ACTIONS.map(base => merge(base, byId.get(base.id))), surfaces: SURFACES, categories };
}

async function update(actionId, body, userId) {
  const base = ACTIONS.find(action => action.id === actionId);
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
