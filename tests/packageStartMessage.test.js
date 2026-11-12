const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { definitions } = require('../helpers/emailDefinitions');
const { EmailTemplate } = require('../models/emailControlModel');
const { systemTemplate } = require('../helpers/emailTemplates');
const { render } = require('../helpers/emailMarkup');

test('package start details use the frozen order and preserve edited templates', async () => {
  const db = await MongoMemoryServer.create();
  try {
    await mongoose.connect(db.getUri());
    const definition = definitions['plan.started'];
    const order = { _id: new mongoose.Types.ObjectId(), userId: { name: 'Client', email: 'client@example.test' },
      salesPackage: { package: { id: 'care' } }, serviceCyclePrice: 3000, serviceTenureMonths: 6,
      servicePlanSnapshot: { serviceName: 'Care', selectedBillingCycle: 'monthly' } };
    const values = definition.build(order).values;
    assert.equal(values.packagePrice, '₹3,000');
    assert.equal(values.packageDuration, '6 months');
    assert.match(values.startInstructions, /work progresses/);
    assert.match(render(definition.text, values, {}, { plain: true }), /₹3,000/);
    const ordinary = definition.build({ ...order, salesPackage: undefined }).values;
    assert.equal(ordinary.packagePrice, ''); assert.equal(ordinary.packageDuration, '');
    assert.match(ordinary.startInstructions, /send your data/);
    const old = definition.replaceUntouched.text;
    await EmailTemplate.create({ event: 'plan.started', name: 'Standard', system: true, subject: definition.subject, text: old });
    assert.equal((await systemTemplate('plan.started')).text, definition.text, 'untouched standard gains the new details');
    await EmailTemplate.updateOne({ event: 'plan.started', system: true }, { $set: { text: 'Custom wording {{plan}}' } });
    assert.equal((await systemTemplate('plan.started')).text, 'Custom wording {{plan}}', 'edited standard is not overwritten');
    await EmailTemplate.updateOne({ event: 'plan.started', system: true }, { $set: { subject: 'Custom subject', text: old } });
    assert.equal((await systemTemplate('plan.started')).text, old, 'a subject-only edit is preserved too');
  } finally { await mongoose.disconnect(); await db.stop(); }
});
