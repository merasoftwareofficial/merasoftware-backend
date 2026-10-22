// SSOT for project categories: the admin Project Categories page, both project-creation paths,
// the customer customize form and the sales catalogue all read categories through this module.
//
// A category key is permanent — every project order stores it in projectSnapshot.category and the
// website offers/packages store it too — so keys are created once and only ever archived.
const CategoryModel = require('../models/categoryBasePriceModel');

const KEY_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;

// Keys the legacy product catalogue, plans and banners already use. A project category reusing one
// would be misread by orderStatusEngine.js / orderType.js as a plan or a catalogue product.
const RESERVED_KEYS = new Set([
  'website_updates', 'service_plan', 'feature_upgrades', 'web_applications', 'mobile_apps',
  'static_websites', 'app_update', 'home', 'home_second_banner',
]);

// The four categories that existed before this SSOT. Their values fill in rows saved before the
// newer fields existed. `locked`: the customer questionnaire (StartNewWebsiteBuild.js) sends
// customers straight to these two, so they cannot be archived, hidden or left without a price.
const BUILT_IN = {
  standard_websites: { label: 'Standard Website', sortOrder: 0, locked: true },
  dynamic_websites: { label: 'Dynamic Website', sortOrder: 1, locked: true },
  cloud_software_development: { label: 'Cloud Software', sortOrder: 2, locked: false },
  app_development: { label: 'App Development', sortOrder: 3, locked: false },
};

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

const normalise = (row) => {
  const builtIn = BUILT_IN[row.category];
  const basePrice = row.basePrice ?? null;
  return {
    category: row.category,
    label: row.label || builtIn?.label || row.category,
    basePrice,
    configured: basePrice !== null,
    description: row.description || '',
    startingNodeTitle: row.startingNodeTitle || '',
    status: row.status || 'active',
    sortOrder: row.sortOrder ?? builtIn?.sortOrder ?? 9999,
    // Built-in categories were always offered to customers; new ones start admin-only.
    customerSelectable: row.customerSelectable ?? Boolean(builtIn),
    locked: Boolean(builtIn?.locked),
    updatedAt: row.updatedAt || null,
  };
};

async function listProjectCategories() {
  const rows = await CategoryModel.find().lean();
  const stored = new Set(rows.map(row => row.category));
  const missingBuiltIns = Object.keys(BUILT_IN).filter(key => !stored.has(key)).map(category => ({ category }));
  return [...rows, ...missingBuiltIns].map(normalise)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

async function getProjectCategory(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return null;
  const row = await CategoryModel.findOne({ category: key }).lean();
  if (row) return normalise(row);
  return BUILT_IN[key] ? normalise({ category: key }) : null;
}

// The single rule for "can a NEW project use this category". Admin projects only need an active
// category (the admin types the price); a customer order is priced from basePrice, so it also needs
// a configured price and a category the admin opened to customers.
async function requireCategoryForNewProject(key, { customer = false } = {}) {
  const category = await getProjectCategory(key);
  if (!category || category.status !== 'active') fail('This project category is unavailable. Refresh and choose another.');
  if (customer && (!category.customerSelectable || !category.configured)) fail('This project category is not available for online orders.');
  return category;
}

// Where each category is used, so the admin sees the impact before archiving or editing it.
async function categoryUsage() {
  const Order = require('../models/orderProductModel');
  const Product = require('../models/productModel');
  const { readPackages } = require('./salesPackages');
  const [projects, features, packages] = await Promise.all([
    Order.aggregate([{ $match: { 'projectSnapshot.category': { $type: 'string' } } }, { $group: { _id: '$projectSnapshot.category', count: { $sum: 1 } } }]),
    Product.aggregate([{ $match: { category: 'feature_upgrades' } }, { $unwind: '$compatibleWith' }, { $group: { _id: '$compatibleWith', count: { $sum: 1 } } }]),
    readPackages(),
  ]);
  const usage = {};
  const add = (key, field, count) => { usage[key] = usage[key] || { projects: 0, features: 0, packages: 0 }; usage[key][field] += count; };
  projects.forEach(row => add(row._id, 'projects', row.count));
  features.forEach(row => add(row._id, 'features', row.count));
  packages.forEach(item => add(item.category, 'packages', 1));
  return usage;
}

const text = (value, max, label, required = false) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(`Enter a valid ${label}`);
  return value.trim();
};

// Create (creating === true) or partially update a category. Only the fields sent are changed,
// so the pre-SSOT admin page that sends just price/description/node title keeps working.
async function saveProjectCategory(body, actorId) {
  const key = body?.category;
  const creating = body?.creating === true;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) fail('Use 3–40 lowercase letters, numbers or underscores for the category key, starting with a letter');
  if (RESERVED_KEYS.has(key)) fail('This key is reserved by the existing catalogue. Choose another.');

  const existing = await getProjectCategory(key);
  if (creating && existing) fail('A category with this key already exists', 409);
  if (!creating && !existing) fail('Category not found', 404);

  const update = {};
  const label = text(body.label, 60, 'category name', true);
  if (creating && label === undefined) fail('Enter a category name');
  if (label !== undefined) update.label = label;
  const description = text(body.description, 1000, 'description');
  if (description !== undefined) update.description = description;
  const startingNodeTitle = text(body.startingNodeTitle, 120, 'starting node title');
  if (startingNodeTitle !== undefined) update.startingNodeTitle = startingNodeTitle;

  if (body.basePrice !== undefined) {
    if (body.basePrice === null || body.basePrice === '') update.basePrice = null;
    else {
      const price = Number(body.basePrice);
      if (!Number.isFinite(price) || price < 0 || price > 10000000 || Math.round(price * 100) / 100 !== price) fail('Base price must be zero or more, with at most two decimal places');
      update.basePrice = price;
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
  if (body.customerSelectable !== undefined) {
    if (typeof body.customerSelectable !== 'boolean') fail('Choose whether customers can order this category');
    update.customerSelectable = body.customerSelectable;
  }

  const next = normalise({ ...(existing || { category: key, customerSelectable: false }), ...update });
  if (next.locked && (next.status !== 'active' || !next.customerSelectable || !next.configured)) {
    fail('This category is used by the customer website questionnaire, so it must stay active, open to customers and priced.');
  }

  if (creating) {
    // A plain insert, so two admins creating the same key cannot overwrite each other.
    try {
      const created = await CategoryModel.create({ status: 'active', customerSelectable: false, ...update, category: key, updatedBy: actorId });
      return normalise(created.toObject());
    } catch (error) {
      if (error.code === 11000) fail('A category with this key already exists', 409);
      throw error;
    }
  }
  // Upsert: a built-in category may not have a stored row yet.
  const row = await CategoryModel.findOneAndUpdate(
    { category: key },
    { $set: { ...update, updatedBy: actorId } },
    { new: true, upsert: true, runValidators: true, lean: true },
  );
  return normalise(row);
}

module.exports = {
  KEY_PATTERN,
  RESERVED_KEYS,
  BUILT_IN,
  listProjectCategories,
  getProjectCategory,
  requireCategoryForNewProject,
  categoryUsage,
  saveProjectCategory,
};
