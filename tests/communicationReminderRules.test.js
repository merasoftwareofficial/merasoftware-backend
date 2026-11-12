const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDraft } = require('../helpers/communicationReminderRules');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Run = require('../models/communicationReminderRunModel');
const { persistPackageRuns } = require('../helpers/packageReminderSchedule');
const rule = () => ({ name: 'Payment', source: 'monthly_package', steps: [
  { offsetDays: 0, subject: 'Due {{dueDate}}', text: 'Hello {{name}}, please pay {{amount}}.', channel: 'whatsapp' },
  { offsetDays: -3, subject: 'Upcoming', text: 'Your {{package}} is due soon.', channel: 'both' },
] });
test('draft validates and sorts its own bounded, action-specific steps without enabling', () => {
  const result = validateDraft(rule());
  assert.equal(result.enabled, false); assert.deepEqual(result.steps.map(step => step.offsetDays), [-3, 0]);
});
test('draft refuses activation, duplicate offsets, invalid channels and unavailable details', () => {
  assert.throws(() => validateDraft({ ...rule(), enabled: true }), /not available yet/);
  assert.throws(() => validateDraft({ ...rule(), steps: [rule().steps[0], rule().steps[0]] }), /different valid whole day/);
  assert.throws(() => validateDraft({ ...rule(), steps: [{ ...rule().steps[0], channel: 'sms' }] }), /channel/);
  assert.throws(() => validateDraft({ ...rule(), source: 'broadcast' }), /unavailable/);
});
test('one occurrence and step can be persisted only once even on concurrent attempts', async () => {
  const database = await MongoMemoryServer.create();
  try {
    await mongoose.connect(database.getUri()); await Run.init();
    const ruleId = new mongoose.Types.ObjectId(), entityId = new mongoose.Types.ObjectId(), clientId = new mongoose.Types.ObjectId();
    const run = { ruleId, ruleRevision: 1, source: 'monthly_package', occurrenceKey: `${entityId}:2`, step: 0, entityId, clientId,
      dueAt: new Date(), subject: 'Due soon', text: 'Please check.', channel: 'whatsapp' };
    const outcomes = await Promise.allSettled([Run.create(run), Run.create(run)]);
    assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(await Run.countDocuments(), 1);
    assert.equal((await Run.findOne()).status, 'scheduled');
    await Promise.all([persistPackageRuns([run]), persistPackageRuns([run])]);
    assert.equal(await Run.countDocuments(), 1, 'repeated planning preserves the original run');
    const moved = { ...run, dueAt: new Date(Date.now() + 60000), anchorAt: new Date(Date.now() + 120000) };
    await persistPackageRuns([moved]);
    assert.equal(+(await Run.findOne()).dueAt, +moved.dueAt, 'an unattempted run follows the actual invoice date');
    await Run.updateOne({}, { $set: { status: 'sent' } });
    await persistPackageRuns([{ ...moved, dueAt: new Date(Date.now() + 180000) }]);
    assert.equal(+(await Run.findOne()).dueAt, +moved.dueAt, 'an attempted run never moves');
  } finally { await mongoose.disconnect(); await database.stop(); }
});
