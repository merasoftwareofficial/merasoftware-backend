const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInstallments } = require('../helpers/projectInstallments');
const { quotePackage, calculateBenefit, validatePackage } = require('../helpers/salesPackages');
const { STARTER_PACKAGES } = require('./fixtures/salesPackages');
const { buildLineItemsFromOrder } = require('../helpers/paymentRecording');
const live = { slug: 'page', title: 'Starter', status: 'published', endsAt: '2099-01-01T00:00:00Z', applicableCategories: ['standard_websites'], packageIds: [], pricingRule: 'fixed_price', mainPrice: 10000, offerPrice: 699, resolvedTerms: ['Saved offer term'] };

test('installments preserve every paise for odd, fractional, free and small totals', () => {
  for (const total of [0, 0.01, 1, 699, 699.99, 2699, 4699, 10000.01]) for (const count of [2, 3]) {
    const rows = buildInstallments(total, count);
    assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(total * 100));
    assert(rows.every(row => row.amount >= 0));
  }
});
test('offer expiry/category eligibility is enforced, and quote versions include scope/terms', () => {
  const item = STARTER_PACKAGES[0];
  const initial = quotePackage(item, [live]);
  assert.equal(initial.quote.finalPrice, 699);
  for (const patch of [{ endsAt: '2000-01-01T00:00:00Z' }, { status: 'draft' }, { applicableCategories: ['app_development'] }]) {
    assert.equal(quotePackage(item, [{ ...live, ...patch }]).quote.finalPrice, 10000);
  }
  assert.notEqual(quotePackage({ ...item, inclusions: ['Updated scope'] }, [live]).quoteKey, initial.quoteKey);
  assert.notEqual(quotePackage(item, [{ ...live, resolvedTerms: ['Changed terms'] }]).quoteKey, initial.quoteKey);
  assert.equal(quotePackage(STARTER_PACKAGES[1], [live]).quote.finalPrice, 2699);
  // The package's own offerSlug is the only link; the offer's old package list no longer filters.
  assert.equal(quotePackage(item, [{ ...live, packageIds: ['other'] }]).quote.finalPrice, 699);
});
test('package version follows the offer quoteKey: display/timing settings do not invalidate an open project form', () => {
  const item = STARTER_PACKAGES[0];
  const signed = { ...live, quoteKey: 'offer-key-1' };
  const initial = quotePackage(item, [signed]);
  // The website leaves the reserve window out of the offer key, so only the window changed here.
  assert.equal(quotePackage(item, [{ ...signed, reserveWindowHours: 48 }]).quoteKey, initial.quoteKey);
  // A commercial change gives the offer a new key, and the package version follows it.
  assert.notEqual(quotePackage(item, [{ ...signed, resolvedTerms: ['Changed terms'], quoteKey: 'offer-key-2' }]).quoteKey, initial.quoteKey);
  assert.notEqual(quotePackage({ ...item, inclusions: ['Updated scope'] }, [signed]).quoteKey, initial.quoteKey);
  // Without a key the full offer is signed, as before.
  assert.notEqual(quotePackage(item, [{ ...live, reserveWindowHours: 48 }]).quoteKey, quotePackage(item, [live]).quoteKey);
});
test('package has a main and a discounted price; an offer replaces the discount and is calculated from the main price', () => {
  const item = { ...STARTER_PACKAGES[0], regularPrice: 14000, discountedPrice: 12000, offerSlug: '' };
  assert.deepEqual(quotePackage(item, [live]).quote, { discountAmount: 0, finalPrice: 12000, regularPrice: 12000, offer: null, terms: item.terms });
  const percent = { ...live, pricingRule: 'percentage', benefitValue: 10 };
  const withOffer = quotePackage({ ...item, offerSlug: 'page' }, [percent]).quote;
  assert.deepEqual([withOffer.regularPrice, withOffer.discountAmount, withOffer.finalPrice], [14000, 1400, 12600]);
  assert.equal(quotePackage({ ...item, discountedPrice: undefined }, []).quote.finalPrice, 14000);
  assert.equal(validatePackage(item).discountedPrice, 12000);
  assert.throws(() => validatePackage({ ...item, discountedPrice: 14000.01 }), /cannot be more than the main price/);
  assert.throws(() => validatePackage({ ...item, discountedPrice: undefined }), /discounted price/);
});
test('discount rules reject invalid results; package input cannot target unsafe keys', () => {
  assert.equal(calculateBenefit(1000, { pricingRule: 'percentage', benefitValue: 10 }).finalPrice, 900);
  assert.equal(calculateBenefit(1000, { pricingRule: 'fixed_discount', benefitValue: 100.5 }).finalPrice, 899.5);
  assert.throws(() => calculateBenefit(100, { pricingRule: 'fixed_price', offerPrice: 699 }));
  assert.throws(() => calculateBenefit(100, { pricingRule: 'percentage', benefitValue: 101 }));
  for (const id of ['constructor', '__proto__', 'a.b']) assert.throws(() => validatePackage({ ...STARTER_PACKAGES[0], id }));
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
test('invoice rows list a hand-typed package with its included lines, never its terms', () => {
  const { buildInvoiceRows } = require('../helpers/generateInvoiceDocumentPdf');
  const order = { projectSnapshot: { salesAgreement: { version: 2,
    package: { name: 'Saved Starter' }, regularPrice: 10000, offerDiscount: 9301, offer: { title: 'Saved Offer' },
    scope: ['Included website', 'Google profile'], terms: ['Agreed term 1'], extras: [],
    priceAdjustment: 501, adjustmentLabel: 'Extra custom work' } } };
  const rows = buildInvoiceRows({ invoice: { amount: 1200 }, order, targetTotal: 1200 });
  assert.deepEqual(rows.map(row => [row.name, row.price]), [['Saved Starter', 10000], ['Offer benefit (Saved Offer)', -9301], ['Extra custom work', 501]]);
  assert.deepEqual(rows[0].bullets, ['Included website', 'Google profile']);
  assert(!JSON.stringify(rows).includes('Agreed term'), 'terms are never printed on an invoice');
});
test('invoice rows list a package priced from its category and add-ons with every part and price', () => {
  const { buildInvoiceRows } = require('../helpers/generateInvoiceDocumentPdf');
  const order = { projectSnapshot: { categoryLabel: 'Standard Website', salesAgreement: { version: 2, regularPrice: 14500, offerDiscount: 0, extras: [],
    package: { name: 'Auto', category: 'standard_websites', pricing: { categoryBasePrice: 10000, services: [
      { featureId: 'a', name: 'SEO setup', unitPrice: 3000, isQuantityBased: false, quantity: 1 },
      { featureId: 'b', name: 'Extra page', unitPrice: 500, isQuantityBased: true, quantity: 3 }] } },
    scope: ['Typed included line'] } } };
  const rows = buildInvoiceRows({ invoice: { amount: 14500 }, order, targetTotal: 14500 });
  assert.deepEqual(rows.map(row => [row.name, row.price]), [['Auto', undefined], ['Standard Website base price', 10000], ['SEO setup', 3000], ['Extra page', 1500]]);
  assert.equal(rows[3].detail, '3 x Rs 500');
  assert(rows.every(row => !row.bullets), 'the typed included lines are not repeated beside the priced parts');
});
test('invoice rows always add up: a typed package discount and a stray difference get their own lines', () => {
  const { buildInvoiceRows } = require('../helpers/generateInvoiceDocumentPdf');
  const pricing = { categoryBasePrice: 10000, services: [{ featureId: 'a', name: 'SEO setup', unitPrice: 3000, isQuantityBased: false, quantity: 1 }] };
  const make = (regularPrice) => ({ projectSnapshot: { categoryLabel: 'Standard Website', salesAgreement: { version: 2, regularPrice, offerDiscount: 0, extras: [], package: { name: 'Auto', category: 'standard_websites', pricing } } } });
  const sum = rows => rows.reduce((total, row) => total + (row.price || 0), 0);
  const discounted = buildInvoiceRows({ invoice: { amount: 9000 }, order: make(9000), targetTotal: 9000 });
  assert.deepEqual(discounted.at(-1), { name: 'Package discount', price: -4000 });
  assert.equal(sum(discounted), 9000);
  const stray = buildInvoiceRows({ invoice: { amount: 9500 }, order: make(9000), targetTotal: 9500 });
  assert.deepEqual(stray.at(-1), { name: 'Agreed price adjustment', price: 500 });
  assert.equal(sum(stray), 9500);
});
test('an order without an agreement still lists its saved invoice line items', () => {
  const { buildInvoiceRows } = require('../helpers/generateInvoiceDocumentPdf');
  const rows = buildInvoiceRows({ invoice: { amount: 3500, lineItems: [{ name: 'Standard Website (Base)', price: 3000 }, { name: 'Logo', price: 500 }] }, order: { projectSnapshot: {} }, targetTotal: 3500 });
  assert.deepEqual(rows, [{ name: 'Standard Website (Base)', price: 3000 }, { name: 'Logo', price: 500 }]);
});
test('final invoice PDF is a real multi-page PDF with a footer on every page and no terms text', async () => {
  const { generateInvoiceDocumentPdf } = require('../helpers/generateInvoiceDocumentPdf');
  const order = { projectSnapshot: { displayName: 'Client Project', salesAgreement: { version: 2, package: { name: 'Saved Starter' }, regularPrice: 10000, offerDiscount: 9301, offer: { title: 'Saved Offer' },
    scope: Array.from({ length: 50 }, (_, i) => `Included work item ${i + 1} described at some length so that the page fills up`), terms: Array.from({ length: 45 }, (_, i) => `Agreed term ${i + 1}`), extras: [] } }, totalAmount: 699 };
  const pdf = await generateInvoiceDocumentPdf({ invoice: { invoiceType: 'project_final', invoiceNumber: 'INV-1', amount: 699, amountPaid: 0, status: 'unpaid' }, order, customer: { name: 'Fixture' }, transactions: [] });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const text = pdf.toString('latin1');
  assert(/\/Count [2-9]\b/.test(text), 'fifty included lines run onto more pages');
  assert(!text.includes('Agreed term'), 'terms never reach the PDF');
});

test('a plan statement is a real PDF in the same layout, with no terms and no project wording', async () => {
  const { generateInvoiceDocumentPdf, buildInvoiceRows } = require('../helpers/generateInvoiceDocumentPdf');
  const order = { isServicePlan: true, serviceTotalCycles: 1, servicePlanSnapshot: { serviceName: 'Website Update Plan' }, orderItems: [{ name: 'Website Update Plan' }], totalAmount: 1152 };
  const invoice = { invoiceType: 'service_statement', invoiceNumber: 'INV-1', amount: 1152, amountPaid: 1152, status: 'paid', lineItems: [{ name: 'Website Update Plan', price: 1152 }] };
  assert.deepEqual(buildInvoiceRows({ invoice, order, targetTotal: 1152 }), [{ name: 'Website Update Plan', price: 1152 }]);
  const pdf = await generateInvoiceDocumentPdf({ invoice, order, customer: { name: 'Fixture' }, transactions: [{ amount: 1152, paymentMethod: 'upi', date: new Date('2026-10-30') }] });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const many = await generateInvoiceDocumentPdf({ invoice, order: { ...order, serviceTotalCycles: 12 }, customer: { name: 'Fixture' }, transactions: [] });
  assert.equal(many.subarray(0, 4).toString(), '%PDF');
});
