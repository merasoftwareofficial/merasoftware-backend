// Flexible Plans P2e (merasoftware/src/docs/plan.md §7 Q4, owner decision 28 Oct 2026):
// puts the 3 live plans into the new settings. Orders are never touched (each keeps its snapshot).
//
//   Categories created if missing: website_updates "Website Updates", website_features "Website Features".
//   Starter Update Plan  -> Website Updates, fixed, billing prices rounded to whole rupees, max 12 months.
//   Single Page Adition  -> Website Updates, fixed, one-time validity 90 days.
//   Live Chat Feature    -> Website Features, fixed.
//
// DRY RUN by default: prints every change and writes nothing (all MongoDB writes are blocked).
// --apply writes, after saving the 3 plans as they are now to a JSON backup file outside the repo.
//
// PowerShell, from E:\Allprojects\backend:
//   $env:MONGODB_URI = "<production URI>"; node scripts/applyLivePlanSettings.js
//   $env:MONGODB_URI = "<production URI>"; node scripts/applyLivePlanSettings.js --apply
//   Remove-Item Env:MONGODB_URI
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); // never overrides a URI set in the shell

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'backup', 'backend', 'live-plan-settings');

const CATEGORIES = [
  { key: 'website_updates', label: 'Website Updates', sortOrder: 0 },
  { key: 'website_features', label: 'Website Features', sortOrder: 1 },
];
const PLANS = [
  { serviceName: 'Starter Update Plan', set: { categoryKey: 'website_updates', pricingMode: 'fixed', maxTenureMonths: 12 }, roundBilling: true },
  { serviceName: 'Single Page Adition', set: { categoryKey: 'website_updates', pricingMode: 'fixed', oneTimeValidityDays: 90 } },
  { serviceName: 'Live Chat Feature', set: { categoryKey: 'website_features', pricingMode: 'fixed' } },
];

function installWriteGuard() {
  const proto = mongoose.mongo.Collection.prototype;
  for (const method of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite', 'createIndex', 'createIndexes', 'drop']) {
    proto[method] = function blocked() { throw new Error(`DRY RUN: blocked ${method} on ${this.collectionName}`); };
  }
}

// Works out every change without writing. Returns { categories, plans } of planned changes.
async function planChanges(db) {
  const { rupees, assertPricingConfig } = require('../helpers/servicePlanPricing');
  const categories = [];
  for (const category of CATEGORIES) {
    const existing = await db.collection('serviceplancategories').findOne({ key: category.key });
    if (!existing) categories.push(category);
  }
  const plans = [];
  for (const target of PLANS) {
    const rows = await db.collection('products').find({ isServicePlan: true, serviceName: target.serviceName, retiredAt: null }).toArray();
    if (rows.length !== 1) throw new Error(`Expected exactly 1 live plan named "${target.serviceName}", found ${rows.length}. Nothing written.`);
    const plan = rows[0];
    const set = {};
    Object.entries(target.set).forEach(([field, value]) => {
      if (plan.servicePlan?.[field] !== value) set[`servicePlan.${field}`] = value;
    });
    if (target.roundBilling) {
      const rounded = (plan.servicePlan?.billingOptions || []).map((option) => ({ ...option, pricePerCycle: rupees(option.pricePerCycle) }));
      if (rounded.some((option, index) => option.pricePerCycle !== plan.servicePlan.billingOptions[index].pricePerCycle)) set['servicePlan.billingOptions'] = rounded;
    }
    // The result must pass the same rules a saved plan does.
    const next = { ...plan, servicePlan: { ...plan.servicePlan } };
    Object.entries(set).forEach(([field, value]) => { next.servicePlan[field.replace('servicePlan.', '')] = value; });
    assertPricingConfig(next);
    plans.push({ _id: plan._id, serviceName: plan.serviceName, set, before: plan });
  }
  return { categories, plans };
}

async function apply(db, changes) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `plans-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(changes.plans.map((plan) => plan.before), null, 2));
  for (const category of changes.categories) {
    await db.collection('serviceplancategories').insertOne({ ...category, description: '', linkedProjectCategory: null, status: 'active', createdAt: new Date(), updatedAt: new Date() });
  }
  for (const plan of changes.plans) {
    if (Object.keys(plan.set).length) await db.collection('products').updateOne({ _id: plan._id }, { $set: { ...plan.set, updatedAt: new Date() } });
  }
  return file;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  if (!APPLY) installWriteGuard();
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName} — ${APPLY ? 'APPLY' : 'DRY RUN (nothing is written)'}`);
  const changes = await planChanges(db);
  console.log('Categories to create:', changes.categories.length ? changes.categories.map((c) => `${c.key} "${c.label}"`).join(', ') : 'none');
  changes.plans.forEach((plan) => console.log(`${plan.serviceName}:`, Object.keys(plan.set).length ? JSON.stringify(plan.set) : 'already up to date'));
  if (APPLY) console.log(`Applied. Backup of the plans before: ${await apply(db, changes)}`);
  await mongoose.disconnect();
}

if (require.main === module) main().catch(async (error) => { console.error(error.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });

module.exports = { planChanges, apply, CATEGORIES, PLANS };
