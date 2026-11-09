// Package working copies (helpers/packageDrafts.js, merasoftware/src/docs/package-offers.md): a draft saves
// with only its name, reserves its ID, refuses a save from an older copy, and never reaches the live catalogue.
// Isolated MongoDB; the website is never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Catalogue = require('../models/salesCatalogueModel');
const Draft = require('../models/packageDraftModel');
const Category = require('../models/categoryBasePriceModel');
const { savePackage, catalogueWithQuotes, unlinkPackagePage } = require('../helpers/salesPackages');
const drafts = require('../helpers/packageDrafts');

const item = { name: 'Business Starter', description: 'A business website.', status: 'published', category: 'standard_websites', billing: 'one_time', portalUploads: true, paymentOptions: ['full'],
  regularPrice: 15000, discountedPrice: 9999, offerExtraPrice: 0, offerSlug: '', inclusions: ['Website'], terms: [], linkedPlanIds: [], order: 0, pages: ['one-time'] };
const pages = [{ slug: 'one-time' }];
let database;
before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Catalogue, Draft, Category].map(model => model.init()));
});
after(async () => { await mongoose.disconnect(); await database.stop(); });
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  await Category.create({ category: 'standard_websites', basePrice: 10000 });
});
const status = async promise => { try { await promise; return 200; } catch (error) { return error.statusCode; } };

test('a draft saves with only the name; wrong values are kept as typed', async () => {
  assert.equal(await status(drafts.saveDraft({ data: { item: { name: '  ' } } })), 400);
  assert.equal(await status(drafts.saveDraft({ data: {} })), 400);
  const saved = await drafts.saveDraft({ data: { item: { name: 'Business Starter', regularPrice: -5, description: '', design: { contactHref: 'not a link' } } } });
  assert.equal(saved.packageId, 'business-starter');
  assert.equal(saved.version, 1);
  assert.equal(saved.data.item.regularPrice, -5);
  assert.equal(saved.data.item.id, 'business-starter');
  // Nothing of it is in the live catalogue, for the admin or the public.
  assert.deepEqual(await catalogueWithQuotes([], true), []);
  assert.deepEqual(await catalogueWithQuotes([]), []);
});

test('an offer in a draft needs only its name', async () => {
  assert.equal(await status(drafts.saveDraft({ data: { item: { name: 'Pack' }, offer: { title: '' } } })), 400);
  const saved = await drafts.saveDraft({ data: { item: { name: 'Pack' }, offer: { title: 'Diwali', offerPrice: '' } } });
  assert.equal(saved.data.offer.title, 'Diwali');
});

test('a draft reserves its ID: other drafts and automatic package IDs skip it', async () => {
  const first = await drafts.saveDraft({ data: { item: { name: 'Business Starter' } } });
  const second = await drafts.saveDraft({ data: { item: { name: 'Business Starter' } } });
  assert.deepEqual([first.packageId, second.packageId], ['business-starter', 'business-starter-2']);
  const live = await savePackage({ ...item, id: '' }, true, [], pages);
  assert.equal(live.id, 'business-starter-3');
  // Publishing the draft uses its own reserved ID.
  const published = await savePackage({ ...item, id: first.packageId }, true, [], pages);
  assert.equal(published.id, 'business-starter');
  // A new draft never takes a live ID either.
  await drafts.deleteDraft(first.packageId, first.version);
  assert.equal((await drafts.saveDraft({ data: { item: { name: 'Business Starter' } } })).packageId, 'business-starter-4');
});

test('a save from an older copy is refused; a published package gets its first copy with version 0', async () => {
  await savePackage({ ...item, id: '' }, true, [], pages);
  assert.equal(await status(drafts.saveDraft({ packageId: 'missing', version: 0, data: { item: { name: 'X' } } })), 404);
  const one = await drafts.saveDraft({ packageId: 'business-starter', version: 0, data: { item: { ...item, name: 'Business Starter v2' } } });
  assert.equal(one.version, 1);
  assert.equal(await status(drafts.saveDraft({ packageId: 'business-starter', version: 0, data: { item: { name: 'Other' } } })), 409);
  const two = await drafts.saveDraft({ packageId: 'business-starter', version: 1, data: { item: { name: 'Business Starter v3' } } });
  assert.equal(two.version, 2);
  assert.equal(await status(drafts.saveDraft({ packageId: 'business-starter', version: 1, data: { item: { name: 'Stale' } } })), 409);
  // The live package is untouched by its copy.
  assert.equal((await catalogueWithQuotes([], true))[0].name, 'Business Starter');
  // Delete only with the current version.
  assert.equal(await status(drafts.deleteDraft('business-starter', 1)), 409);
  assert.deepEqual(await drafts.deleteDraft('business-starter', 2), { packageId: 'business-starter', deleted: true });
  assert.equal(await status(drafts.saveDraft({ packageId: 'business-starter', version: 2, data: { item: { name: 'Late' } } })), 409);
  assert.deepEqual(await drafts.listDrafts(), []);
});

test('ending an offer clears it from the copy, and a deleted page leaves drafts', async () => {
  await savePackage({ ...item, id: '' }, true, [], pages);
  await drafts.saveDraft({ packageId: 'business-starter', version: 0, data: { item: { ...item }, offer: { title: 'Diwali', base: { slug: 'diwali' } } } });
  assert.deepEqual(await drafts.clearDraftOffer('business-starter', 'other'), { packageId: 'business-starter', cleared: false });
  assert.deepEqual(await drafts.clearDraftOffer('business-starter', 'diwali'), { packageId: 'business-starter', cleared: true });
  const [copy] = await drafts.listDrafts();
  assert.equal(copy.data.offer, null);
  assert.equal(copy.version, 2);
  await unlinkPackagePage('one-time');
  await drafts.unlinkDraftPage('one-time');
  assert.deepEqual((await drafts.listDrafts())[0].data.item.pages, []);
  assert.deepEqual((await catalogueWithQuotes([], true))[0].pages, []);
});
