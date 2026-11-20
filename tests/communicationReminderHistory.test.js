const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Run = require('../models/communicationReminderRunModel');
const Lead = require('../models/leadModel');
const { reminderHistory } = require('../helpers/communicationReminderHistory');

test('reminder activity filters on persisted status and the India calendar day', async () => {
  const db = await MongoMemoryServer.create();
  try {
    await mongoose.connect(db.getUri());
    const ruleId = new mongoose.Types.ObjectId(), clientId = new mongoose.Types.ObjectId(), entityId = new mongoose.Types.ObjectId();
    const lead = await Lead.create({ name: 'Test Lead', phone: '9876543210' });
    const now = new Date('2026-11-12T18:40:00Z'); // 00:10 on 13 Nov in India
    const base = { ruleId, ruleRevision: 1, source: 'monthly_package', entityId, clientId, subject: 'Due', text: 'Reminder', channel: 'email' };
    await Run.insertMany([
      { ...base, occurrenceKey: 'a', step: 0, dueAt: new Date('2026-11-12T18:20:00Z'), status: 'sent', sentAt: new Date('2026-11-12T18:32:00Z') },
      { ...base, occurrenceKey: 'b', step: 0, dueAt: new Date('2026-11-12T18:35:00Z'), status: 'partial' },
      { ...base, occurrenceKey: 'c', step: 0, dueAt: new Date('2026-11-13T00:00:00Z'), status: 'scheduled' },
      { ...base, source: 'action', clientId: null, leadId: lead._id, audience: 'admin', occurrenceKey: 'd', step: 0, dueAt: new Date('2026-11-14T00:00:00Z'), status: 'cancelled', reason: 'Trail updated or paused.' },
    ]);
    assert.equal((await reminderHistory({ view: 'all', now })).total, 3);
    assert.equal((await reminderHistory({ view: 'today', now })).total, 2);
    assert.equal((await reminderHistory({ view: 'upcoming', now })).total, 1);
    assert.equal((await reminderHistory({ view: 'sent', now })).total, 1);
    assert.equal((await reminderHistory({ view: 'sent_today', now })).total, 1);
    assert.equal((await reminderHistory({ view: 'attention', now })).total, 1);
    const cancelled = await reminderHistory({ view: 'cancelled', now });
    assert.equal(cancelled.total, 1);
    assert.equal(cancelled.rows[0].customer, 'Test Lead');
    assert.equal(cancelled.rows[0].audience, 'admin');
    await assert.rejects(reminderHistory({ view: 'other', now }), /valid reminder view/);
  } finally { await mongoose.disconnect(); await db.stop(); }
});
