// Opening Email Templates calls ensureSystemTemplates on every open and refresh. It must create what is missing,
// upgrade untouched old wording, leave owner edits alone, and never rewrite (or re-stamp) an existing copy.
// Isolated: in-memory MongoDB, nothing is sent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { EmailTemplate } = require('../models/emailControlModel');
const { definitions } = require('../helpers/emailDefinitions');
const { byKey } = require('../helpers/emailCatalog');
const { ensureSystemTemplates } = require('../helpers/emailTemplates');

let db;
const eventsOf = application => Object.keys(definitions).filter(event => byKey.get(event)?.application === application);
before(async () => { db = await MongoMemoryServer.create(); await mongoose.connect(db.getUri(), { dbName: 'ensure-system-templates' }); await EmailTemplate.init(); });
after(async () => { await mongoose.disconnect(); await db?.stop(); });

test('creates one Standard per action, and six simultaneous first opens neither fail nor duplicate', async () => {
  await EmailTemplate.deleteMany({});
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => ensureSystemTemplates('portal')));
  assert.ok(results.every(result => result.status === 'fulfilled'), JSON.stringify(results.filter(result => result.status === 'rejected')));
  const rows = await EmailTemplate.find({ system: true }).lean();
  assert.equal(rows.length, eventsOf('portal').length);
  assert.ok(rows.every(row => row.name === 'Standard' && row.createdAt && row.updatedAt));
});

test('a repeat open rewrites nothing: an existing copy keeps its updatedAt and an owner edit stays as saved', async () => {
  await EmailTemplate.deleteMany({}); await ensureSystemTemplates('portal');
  await EmailTemplate.collection.updateMany({}, { $set: { updatedAt: new Date(5000) } });
  await EmailTemplate.collection.updateOne({ event: 'offer.reserved', system: true }, { $set: { text: 'OWNER EDIT {{offerTitle}}' } });
  await ensureSystemTemplates('portal');
  assert.equal(await EmailTemplate.countDocuments({ updatedAt: { $ne: new Date(5000) } }), 0, 'a refresh must not move any template revision');
  assert.equal((await EmailTemplate.findOne({ event: 'offer.reserved', system: true }).lean()).text, 'OWNER EDIT {{offerTitle}}');
});

test('untouched old wording moves to the current wording; an edited copy and a custom template are preserved; a missing action is created', async () => {
  await EmailTemplate.deleteMany({}); await ensureSystemTemplates('portal');
  const older = eventsOf('portal').find(event => definitions[event].replaces?.length);
  assert.ok(older, 'the catalogue has an action with earlier wording');
  await EmailTemplate.collection.updateOne({ event: older, system: true }, { $set: { text: definitions[older].replaces[0] } });
  await EmailTemplate.collection.updateOne({ event: 'offer.reserved', system: true }, { $set: { text: 'OWNER EDIT {{offerTitle}}' } });
  await EmailTemplate.collection.insertOne({ event: 'plan.started', system: false, name: 'My own', subject: 'S', text: 'custom {{name}}', createdAt: new Date(), updatedAt: new Date() });
  await EmailTemplate.collection.deleteOne({ event: 'plan.payment.received', system: true });
  await ensureSystemTemplates('portal');
  assert.equal((await EmailTemplate.findOne({ event: older, system: true }).lean()).text, definitions[older].text);
  assert.equal((await EmailTemplate.findOne({ event: 'offer.reserved', system: true }).lean()).text, 'OWNER EDIT {{offerTitle}}');
  assert.equal((await EmailTemplate.findOne({ event: 'plan.started', system: false }).lean()).text, 'custom {{name}}');
  assert.ok(await EmailTemplate.findOne({ event: 'plan.payment.received', system: true }).lean(), 'a missing Standard is created again');
});
