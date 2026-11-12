// Package dates (helpers/salesPackages.js, website "recently added / modified" sorts, 12 Nov 2026): a new package
// gets createdAt, every admin change bumps updatedAt, a package saved before the dates existed never gets an invented
// createdAt, and only packages whose offer really changes get a new updatedAt. Isolated MongoDB; the website is never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Catalogue = require('../models/salesCatalogueModel');
const Category = require('../models/categoryBasePriceModel');
const { savePackage, readPackages, transitionPackageStatus, linkOfferPackages } = require('../helpers/salesPackages');

const item = { name: 'Business Starter', description: 'A business website.', status: 'published', category: 'standard_websites', billing: 'one_time', portalUploads: true, paymentOptions: ['full'],
  regularPrice: 15000, discountedPrice: 9999, offerExtraPrice: 0, offerSlug: '', inclusions: ['Website'], terms: [], linkedPlanIds: [], order: 0, pages: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOUR = 3600000;
let database;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Catalogue, Category].map(model => model.init()));
});
after(async () => { await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
});
const stored = async id => (await readPackages()).find(row => row.id === id);

test('a new package gets createdAt and updatedAt, both real dates', async () => {
  const saved = await savePackage({ ...item, id: '', name: 'Dated new' }, true, []);
  const row = await stored(saved.id);
  assert.ok(row.createdAt instanceof Date, 'createdAt is a date');
  assert.ok(row.updatedAt instanceof Date, 'updatedAt is a date');
  assert.equal(row.createdAt.getTime(), row.updatedAt.getTime(), 'first save: both dates are the same moment');
});

test('an edit keeps createdAt and moves updatedAt forward', async () => {
  const saved = await savePackage({ ...item, id: '', name: 'Dated edit' }, true, []);
  const before = await stored(saved.id);
  await sleep(5);
  await savePackage({ ...item, id: saved.id, name: 'Dated edit', description: 'Changed text.' }, false, []);
  const after = await stored(saved.id);
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime(), 'createdAt is never changed by an edit');
  assert.ok(after.updatedAt.getTime() > before.updatedAt.getTime(), 'updatedAt moves forward on an edit');
  assert.equal(after.description, 'Changed text.');
});

test('a package saved before the dates existed gets no invented createdAt', async () => {
  const saved = await savePackage({ ...item, id: '', name: 'Legacy package' }, true, []);
  await Catalogue.updateOne({ _id: 'packages' }, { $unset: { [`packages.${saved.id}.createdAt`]: '', [`packages.${saved.id}.updatedAt`]: '' } });
  await savePackage({ ...item, id: saved.id, name: 'Legacy package', description: 'Edited.' }, false, []);
  const row = await stored(saved.id);
  assert.equal(row.createdAt, undefined, 'no date is made up for an old package');
  assert.ok(row.updatedAt instanceof Date, 'an admin edit still records its date');
});

test('archiving bumps updatedAt and keeps createdAt', async () => {
  const saved = await savePackage({ ...item, id: '', name: 'Dated archive' }, true, []);
  const before = await stored(saved.id);
  await sleep(5);
  const archived = await transitionPackageStatus(saved.id, 'archived', [], []);
  const row = await stored(saved.id);
  assert.equal(row.status, 'archived');
  assert.equal(row.createdAt.getTime(), before.createdAt.getTime());
  assert.ok(row.updatedAt.getTime() > before.updatedAt.getTime(), 'the archive is a change');
  assert.ok(archived.updatedAt instanceof Date);
});

test('linking an offer dates only the packages whose offer really changed', async () => {
  const linked = await savePackage({ ...item, id: '', name: 'Offer linked' }, true, []);
  const other = await savePackage({ ...item, id: '', name: 'Offer untouched' }, true, []);
  const offer = { slug: 'spring', title: 'Spring', status: 'published', endsAt: new Date(Date.now() + HOUR).toISOString(),
    pricingRule: 'fixed_price', offerPrice: 8000, applicableCategories: ['standard_websites'], resolvedTerms: [], quoteKey: 'spring-v1' };
  const untouchedBefore = await stored(other.id);
  await sleep(5);
  await linkOfferPackages('spring', [linked.id], [offer]);
  const linkedAfter = await stored(linked.id);
  assert.equal(linkedAfter.offerSlug, 'spring');
  assert.ok(linkedAfter.updatedAt instanceof Date && linkedAfter.updatedAt.getTime() > untouchedBefore.updatedAt.getTime(), 'a linked package is dated');
  assert.equal((await stored(other.id)).updatedAt.getTime(), untouchedBefore.updatedAt.getTime(), 'a package not in the change keeps its date');

  const linkedBeforeUnlink = linkedAfter.updatedAt.getTime();
  await sleep(5);
  await linkOfferPackages('spring', [], [offer]);
  const unlinked = await stored(linked.id);
  assert.equal(unlinked.offerSlug, '');
  assert.ok(unlinked.updatedAt.getTime() > linkedBeforeUnlink, 'an unlinked package is dated too');
});
