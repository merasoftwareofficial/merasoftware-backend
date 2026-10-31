const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const leadModel = require('../models/leadModel');
const { LEAD_STATUSES, SELECTABLE_LEAD_STATUSES, FOLLOW_UP_BADGES } = require('../helpers/leadStatuses');
const { mergeNewLeadStatus } = require('../scripts/mergeNewLeadStatus');

let db;
const backupFile = path.join(os.tmpdir(), `lead-status-backup-${process.pid}.json`);
const leads = () => mongoose.connection.db.collection('leads');
const oldLead = (status, badges = []) => leads().insertOne({
  name: 'Lead', phone: '9000000001', status, updatedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01'),
  followUps: badges.map(badge => ({ _id: new mongoose.Types.ObjectId(), note: 'Note', badge, date: new Date(), createdAt: new Date() })),
});

before(async () => {
  db = await MongoMemoryServer.create();
  await mongoose.connect(db.getUri(), { dbName: 'lead-status-isolated-test' });
});
beforeEach(() => leads().deleteMany({}));
after(async () => {
  await mongoose.disconnect();
  await db?.stop();
  fs.rmSync(backupFile, { force: true });
});

test('the status list: New and Proposal Sent are gone, Won and Inquiry cannot be chosen, old badges stay valid', () => {
  assert.deepEqual(LEAD_STATUSES, ['Inquiry', 'Contacted', 'Positive', 'Negative', 'Dead', 'Won']);
  assert.deepEqual(SELECTABLE_LEAD_STATUSES, ['Contacted', 'Positive', 'Negative', 'Dead']);
  assert.deepEqual(FOLLOW_UP_BADGES, ['Inquiry', 'Contacted', 'Positive', 'Negative', 'Dead', 'Won', 'Proposal Sent']);
});

test('Proposal Sent is refused as a status, kept on an old follow-up', async () => {
  await assert.rejects(leadModel.create({ name: 'Lead', status: 'Proposal Sent' }), /not a valid enum value/);
  const { insertedId } = await oldLead('Contacted', ['Proposal Sent']);
  const lead = await leadModel.findById(insertedId);
  lead.notes = 'Edited';
  await lead.save();
  assert.equal((await leadModel.findById(insertedId).lean()).followUps[0].badge, 'Proposal Sent');
});

test('a new lead starts as Contacted and the model refuses New', async () => {
  const lead = await leadModel.create({ name: 'Lead' });
  assert.equal(lead.status, 'Contacted');
  await assert.rejects(leadModel.create({ name: 'Lead', status: 'New' }), /not a valid enum value/);
  lead.followUps.push({ note: 'Note', badge: 'New' });
  await assert.rejects(lead.save(), /not a valid enum value/);
  lead.followUps.pop();
  lead.followUps.push({ note: 'Note', badge: 'Positive' });
  await lead.save();
  assert.equal((await leadModel.findById(lead._id).lean()).followUps[0].badge, 'Positive');
});

test('without apply the merge only counts', async () => {
  await oldLead('New', ['New']);
  const result = await mergeNewLeadStatus(mongoose.connection.db);
  assert.deepEqual(result.before, { statuses: 1, badges: 1 });
  assert.equal(result.applied, false);
  assert.equal((await leads().findOne()).status, 'New');
});

test('apply refuses to run without a backup file', async () => {
  await oldLead('New');
  await assert.rejects(mergeNewLeadStatus(mongoose.connection.db, { apply: true }), /--backup/);
  assert.equal((await leads().findOne()).status, 'New');
});

test('the merge changes New only, keeps updatedAt, saves a backup, and can run again', async () => {
  await oldLead('New', ['New', 'Contacted']);
  await oldLead('Contacted', ['New', 'Proposal Sent', 'New']);
  await oldLead('Won', ['Won']);
  await oldLead('Negative', ['Negative']);

  const result = await mergeNewLeadStatus(mongoose.connection.db, { apply: true, backupFile });
  assert.deepEqual(result.before, { statuses: 1, badges: 3 });
  assert.deepEqual(result.after, { statuses: 0, badges: 0 });

  const rows = await leads().find().sort({ _id: 1 }).toArray();
  assert.deepEqual(rows.map(row => row.status), ['Contacted', 'Contacted', 'Won', 'Negative']);
  assert.deepEqual(rows.map(row => row.followUps.map(item => item.badge)),
    [['Contacted', 'Contacted'], ['Contacted', 'Proposal Sent', 'Contacted'], ['Won'], ['Negative']]);
  assert.ok(rows.every(row => row.updatedAt.getTime() === new Date('2026-01-01').getTime()));
  assert.ok(rows.every(row => row.followUps.every(item => item.note === 'Note')));

  const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.equal(saved.length, 2);
  assert.equal(saved[0].status, 'New');
  assert.deepEqual(saved[1].followUps.map(item => item.badge), ['New', 'Proposal Sent', 'New']);

  const again = await mergeNewLeadStatus(mongoose.connection.db, { apply: true, backupFile });
  assert.deepEqual(again.before, { statuses: 0, badges: 0 });
});

test('a merged old lead can be saved by the model', async () => {
  const { insertedId } = await oldLead('New', ['New']);
  await mergeNewLeadStatus(mongoose.connection.db, { apply: true, backupFile });
  const lead = await leadModel.findById(insertedId);
  lead.notes = 'Edited';
  await lead.save();
  assert.equal((await leadModel.findById(insertedId).lean()).notes, 'Edited');
});
