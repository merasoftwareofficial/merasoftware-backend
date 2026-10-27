// SSOT for plan categories: the website admin plan catalogue, plan create/edit and the public plans
// page all read categories through this module. Same shape and rules as helpers/projectCategories.js:
// a key is created once, never changed, and a category is archived instead of deleted.
const PlanCategory = require('../models/servicePlanCategoryModel');
const { getProjectCategory } = require('./projectCategories');

const KEY_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

const normalise = (row) => ({
  key: row.key,
  label: row.label,
  description: row.description || '',
  linkedProjectCategory: row.linkedProjectCategory || null,
  status: row.status || 'active',
  sortOrder: row.sortOrder ?? 9999,
  updatedAt: row.updatedAt || null,
});

async function listPlanCategories() {
  const rows = await PlanCategory.find().lean();
  return rows.map(normalise).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

async function getPlanCategory(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return null;
  const row = await PlanCategory.findOne({ key }).lean();
  return row ? normalise(row) : null;
}

// The single rule for "can a plan be saved into this category": it must exist and be active.
// A plan already in a category that is archived later keeps it; only a new choice is refused.
async function requireActivePlanCategory(key) {
  const category = await getPlanCategory(key);
  if (!category || category.status !== 'active') fail('This plan category is unavailable. Refresh and choose another.');
  return category;
}

// How many catalogue plans sit in each category, so the admin sees the impact before archiving.
async function planCategoryUsage() {
  const Product = require('../models/productModel');
  const rows = await Product.aggregate([
    { $match: { isServicePlan: true, 'servicePlan.categoryKey': { $type: 'string' } } },
    { $group: { _id: '$servicePlan.categoryKey', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

const text = (value, max, label, required = false) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(`Enter a valid ${label}`);
  return value.trim();
};

// Create (creating === true) or partially update a category. Only the fields sent are changed.
async function savePlanCategory(body, actorId) {
  const key = body?.key;
  const creating = body?.creating === true;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) fail('Use 3–40 lowercase letters, numbers or underscores for the category key, starting with a letter');

  const existing = await getPlanCategory(key);
  if (creating && existing) fail('A plan category with this key already exists', 409);
  if (!creating && !existing) fail('Plan category not found', 404);

  const update = {};
  const label = text(body.label, 60, 'category name', true);
  if (creating && label === undefined) fail('Enter a category name');
  if (label !== undefined) update.label = label;
  const description = text(body.description, 1000, 'description');
  if (description !== undefined) update.description = description;

  if (body.linkedProjectCategory !== undefined) {
    if (body.linkedProjectCategory === null || body.linkedProjectCategory === '') update.linkedProjectCategory = null;
    else {
      if (!await getProjectCategory(body.linkedProjectCategory)) fail('Choose an existing project category to link');
      update.linkedProjectCategory = body.linkedProjectCategory;
    }
  }
  if (body.status !== undefined) {
    if (!['active', 'archived'].includes(body.status)) fail('Choose a valid status');
    update.status = body.status;
  }
  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 9999) fail('Enter a valid display order');
    update.sortOrder = body.sortOrder;
  }

  if (creating) {
    // A plain insert, so two admins creating the same key cannot overwrite each other.
    try {
      const created = await PlanCategory.create({ ...update, key, updatedBy: actorId });
      return normalise(created.toObject());
    } catch (error) {
      if (error.code === 11000) fail('A plan category with this key already exists', 409);
      throw error;
    }
  }
  const row = await PlanCategory.findOneAndUpdate(
    { key },
    { $set: { ...update, updatedBy: actorId } },
    { new: true, runValidators: true, lean: true },
  );
  return normalise(row);
}

module.exports = {
  KEY_PATTERN,
  listPlanCategories,
  getPlanCategory,
  requireActivePlanCategory,
  planCategoryUsage,
  savePlanCategory,
};
