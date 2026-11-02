// Conservative migration for clients with no lead. Explicit plan file and a
// database uniqueness constraint are required. Never attaches an existing lead.
const fs = require('node:fs');
const mongoose = require('mongoose');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { auditClientFinalMessages } = require('./auditClientFinalMessages');

async function preparePlan(filename) {
  const report = await auditClientFinalMessages();
  const accounts = await User.find({ _id: { $in: report.candidates } }).select('name email phone roles isGuest deletedAt').lean();
  const byId = new Map(accounts.map(account => [String(account._id), account]));
  const items = report.candidates.map(id => {
    const user = byId.get(id);
    if (!user) throw new Error('An account disappeared during the audit. Run it again.');
    return { clientId: id, leadId: String(new mongoose.Types.ObjectId()), before: { name: user.name || '', email: user.email || '', phone: user.phone || '' } };
  });
  const plan = { version: 1, database: mongoose.connection.name, host: mongoose.connection.host, createdAt: new Date().toISOString(), items, report: { ...report, candidates: undefined } };
  fs.writeFileSync(filename, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
  return plan;
}

async function applyPlan(filename, { maintenance = false } = {}) {
  if (!maintenance) throw new Error('Apply requires an application-write maintenance window.');
  const plan = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (plan.version !== 1 || plan.database !== mongoose.connection.name || plan.host !== mongoose.connection.host || !Array.isArray(plan.items)) throw new Error('The plan does not belong to this database.');
  const indexes = await Lead.collection.indexes();
  if (!indexes.some(index => index.unique && Object.keys(index.key).length === 1 && index.key.convertedToUserId === 1 && Object.keys(index.partialFilterExpression || {}).length === 1 && Object.keys(index.partialFilterExpression?.convertedToUserId || {}).length === 1 && index.partialFilterExpression?.convertedToUserId?.$type === 'objectId')) throw new Error('A unique partial index on convertedToUserId is required before applying this migration.');
  const result = { created: 0, alreadyCreated: 0, skipped: 0 };
  for (const item of plan.items) {
    if (!mongoose.isObjectIdOrHexString(item.clientId) || !mongoose.isObjectIdOrHexString(item.leadId)) throw new Error('Invalid IDs in the plan.');
    const existing = await Lead.findById(item.leadId).lean();
    if (existing && String(existing.convertedToUserId) === item.clientId) { result.alreadyCreated++; continue; }
    if (existing) throw new Error('A planned lead ID belongs to a different record.');
    const current = await User.findById(item.clientId).select('name email phone roles isGuest deletedAt').lean();
    if (!current || current.deletedAt || current.isGuest || !current.roles?.includes('customer') || (current.name || '') !== item.before.name || (current.email || '') !== item.before.email || (current.phone || '') !== item.before.phone) { result.skipped++; continue; }
    const audit = await auditClientFinalMessages();
    if (!audit.candidates.includes(item.clientId)) { result.skipped++; continue; }
    try {
      await mongoose.connection.transaction(async session => {
        if (await Lead.exists({ convertedToUserId: item.clientId }).session(session)) throw Object.assign(new Error('Client already linked.'), { skip: true });
        await Lead.create([{ _id: item.leadId, name: current.name || current.email, email: String(current.email || '').trim().toLowerCase(), phone: current.phone || '', source: 'Client account', status: 'Won', convertedToUserId: current._id }], { session });
      });
      result.created++;
    } catch (error) {
      if (error.skip || error.code === 11000) { result.skipped++; continue; }
      throw error;
    }
  }
  return result;
}

async function main() {
  const [action, filename] = process.argv.slice(2);
  if (!process.env.MONGODB_URI || !['prepare', 'apply'].includes(action) || !filename) throw new Error('Set MONGODB_URI and run: node scripts/migrateClientFinalMessages.js prepare|apply <new-plan-file>.');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  try {
    if (action === 'prepare') { const plan = await preparePlan(filename); console.log(JSON.stringify({ database: plan.database, candidates: plan.items.length, report: plan.report }, null, 2)); }
    else console.log(JSON.stringify(await applyPlan(filename, { maintenance: process.argv.includes('--maintenance') }), null, 2));
  }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { preparePlan, applyPlan };
