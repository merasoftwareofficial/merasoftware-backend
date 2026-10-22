const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { buildInstallments } = require('../helpers/projectInstallments');
const { DEFAULT_PACKAGES, quotePackage, calculateBenefit, validatePackage } = require('../helpers/salesPackages');
const { buildLineItemsFromOrder } = require('../helpers/paymentRecording');
const live = { slug: 'page', title: 'Starter', status: 'published', endsAt: '2099-01-01T00:00:00Z', applicableCategories: ['standard_websites'], packageIds: [], pricingRule: 'fixed_price', mainPrice: 10000, offerPrice: 699, resolvedTerms: ['Saved offer term'] };

test('installments preserve every paise for odd, fractional, free and small totals', () => {
  for (const total of [0, 0.01, 1, 699, 699.99, 2699, 4699, 10000.01]) for (const count of [2, 3]) {
    const rows = buildInstallments(total, count);
    assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(total * 100));
    assert(rows.every(row => row.amount >= 0));
  }
});
test('offer expiry/category/package eligibility is enforced, and quote versions include scope/terms', () => {
  const item = DEFAULT_PACKAGES[0];
  const initial = quotePackage(item, [live]);
  assert.equal(initial.quote.finalPrice, 699);
  for (const patch of [{ endsAt: '2000-01-01T00:00:00Z' }, { status: 'draft' }, { applicableCategories: ['app_development'] }, { packageIds: ['other'] }]) {
    assert.equal(quotePackage(item, [{ ...live, ...patch }]).quote.finalPrice, 10000);
  }
  assert.notEqual(quotePackage({ ...item, inclusions: ['Updated scope'] }, [live]).quoteKey, initial.quoteKey);
  assert.notEqual(quotePackage(item, [{ ...live, resolvedTerms: ['Changed terms'] }]).quoteKey, initial.quoteKey);
  assert.equal(quotePackage(DEFAULT_PACKAGES[1], [live]).quote.finalPrice, 2699);
});
test('discount rules reject invalid results; package input cannot target unsafe keys', () => {
  assert.equal(calculateBenefit(1000, { pricingRule: 'percentage', benefitValue: 10 }).finalPrice, 900);
  assert.equal(calculateBenefit(1000, { pricingRule: 'fixed_discount', benefitValue: 100.5 }).finalPrice, 899.5);
  assert.throws(() => calculateBenefit(100, { pricingRule: 'fixed_price', offerPrice: 699 }));
  assert.throws(() => calculateBenefit(100, { pricingRule: 'percentage', benefitValue: 101 }));
  for (const id of ['constructor', '__proto__', 'a.b']) assert.throws(() => validatePackage({ ...DEFAULT_PACKAGES[0], id }));
});
test('invoice rows reconcile paise, upward adjustments and separate offer/admin benefits', () => {
  for (const totalAmount of [99.5, 100, 150]) {
    const items = buildLineItemsFromOrder({ totalAmount, orderItems: [{ name: 'Scope', finalPrice: 100 }] });
    assert.equal(items.reduce((sum, item) => sum + item.price, 0), totalAmount);
  }
  const items = buildLineItemsFromOrder({ projectSnapshot: { salesAgreement: {
    version: 1, regularPrice: 10000, offerDiscount: 9301, offer: { title: 'Starter' },
    extras: [{ name: 'Extra design', price: 100.5, quantity: 1 }], adminDiscount: 50, discountReason: 'Approved',
  } } });
  assert.equal(items.reduce((sum, item) => sum + item.price, 0), 749.5);
  assert(items.some(item => item.name.startsWith('Offer benefit')));
  assert(items.some(item => item.name.startsWith('Additional admin discount')));
  for (const priceAdjustment of [501, -199.5]) {
    const v2 = buildLineItemsFromOrder({ projectSnapshot: { salesAgreement: {
      version: 2, regularPrice: 10000, offerDiscount: 9301, offer: { title: 'Starter' },
      extras: [{ name: 'Extra design', price: 100.5, quantity: 1 }], priceAdjustment, adjustmentLabel: 'Client label',
    } } });
    assert.equal(v2.reduce((sum, item) => sum + item.price, 0), 799.5 + priceAdjustment);
    assert.deepEqual(v2.at(-1), { name: 'Client label', price: priceAdjustment });
  }
});
test('final PDF renderer includes saved package, benefit, scope and terms across pages', async () => {
  const printed = [];
  class RecordingPdf extends EventEmitter {
    constructor() { super(); this.y = 48; }
    fontSize() { return this; } fillColor() { return this; }
    text(value) { printed.push(String(value)); return this; }
    heightOfString(value) { return Math.ceil(String(value).length / 80) * 15; }
    moveDown() { return this; } addPage() { printed.push('[page]'); return this; }
    end() { this.emit('data', Buffer.from(printed.join('\n'))); this.emit('end'); }
  }
  const sandbox = { module: { exports: {} }, Buffer, require: name => {
    if (name === 'pdfkit') return RecordingPdf;
    if (name === './dateTime') return { formatIndiaDate: () => '21 Oct 2026' };
    if (name === './orderPresentation') return { getOrderDisplayName: () => 'Client Project' };
    throw new Error(`Unexpected dependency ${name}`);
  } };
  vm.runInNewContext(readFileSync(require.resolve('../helpers/generateInvoiceDocumentPdf'), 'utf8'), sandbox);
  await sandbox.module.exports.generateInvoiceDocumentPdf({ invoice: { invoiceType: 'project_final', amount: 699, amountPaid: 0 }, order: { projectSnapshot: { salesAgreement: {
    package: { name: 'Saved Starter' }, regularPrice: 10000, offerDiscount: 9301, offer: { title: 'Saved Offer' },
    scope: ['Included website'], terms: Array.from({ length: 45 }, (_, i) => `Agreed term ${i + 1}`), extras: [],
    priceAdjustment: 501, adjustmentLabel: 'Extra custom work',
  } } }, customer: { name: 'Fixture' } });
  for (const text of ['Saved Starter', 'Offer applied: Saved Offer', 'Offer benefit: - Rs 9,301', 'Extra custom work: + Rs 501', '- Included website', '- Agreed term 45', 'Rs 699']) assert(printed.includes(text), text);
  assert(printed.includes('[page]'));
});
