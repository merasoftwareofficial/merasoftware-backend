// Website package pages on sales packages (helpers/salesPackages.js): validation, the existence
// check, quote versions, page delete (unlink) and the one-time backfill script.
// Isolated: in-memory MongoDB; the website is never contacted.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Catalogue = require('../models/salesCatalogueModel');
const { validatePackage, quotePackage, savePackage, readPackages, unlinkPackagePage } = require('../helpers/salesPackages');
const { STARTER_PACKAGES, seedStarterPackages } = require('./fixtures/salesPackages');

const PAGES = [{ slug: 'one-time-packages', title: 'One-Time Packages' }, { slug: 'monthly-packages', title: 'Monthly Packages' }];
const draft = { ...STARTER_PACKAGES[0], offerSlug: '' };
let db, uri;

before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 60000 }] });
  uri = db.getUri('package-pages-isolated-test');
  await mongoose.connect(uri);
});
after(async () => { await mongoose.disconnect(); await db.stop(); });
beforeEach(async () => { await Catalogue.deleteMany({}); });

test('pages are optional, de-duplicated and must be safe slugs', () => {
  assert.deepEqual(validatePackage(draft).pages, [], 'a package saved before pages existed has none');
  assert.deepEqual(validatePackage({ ...draft, pages: ['monthly-packages', 'monthly-packages'] }).pages, ['monthly-packages']);
  for (const pages of ['monthly-packages', ['Bad Slug'], ['__proto__'], Array(31).fill('a')]) assert.throws(() => validatePackage({ ...draft, pages }), /valid website pages/);
});

test('changing pages never changes the quote version', () => {
  assert.equal(quotePackage({ ...draft, pages: ['monthly-packages'] }, []).quoteKey, quotePackage(draft, []).quoteKey);
  assert.equal(quotePackage({ ...draft, pages: [] }, []).quoteKey, quotePackage(draft, []).quoteKey);
});

test('a package may only use pages that exist on the website', async () => {
  await assert.rejects(savePackage({ ...draft, pages: ['gone'] }, true, [], PAGES), /no longer exists/);
  await assert.rejects(savePackage({ ...draft, pages: ['one-time-packages'] }, true, []), /no longer exists/, 'no page list from the website means no page is accepted');
  const saved = await savePackage({ ...draft, pages: ['one-time-packages', 'monthly-packages'] }, true, [], PAGES);
  assert.deepEqual(saved.pages, ['one-time-packages', 'monthly-packages']);
  assert.deepEqual((await readPackages())[0].pages, saved.pages);
});

test('deleting a page removes it from every package and keeps the packages', async () => {
  await savePackage({ ...draft, pages: ['one-time-packages', 'monthly-packages'] }, true, [], PAGES);
  await savePackage({ ...draft, id: 'second', pages: ['monthly-packages'] }, true, [], PAGES);
  await savePackage({ ...draft, id: 'third', pages: ['one-time-packages'] }, true, [], PAGES);
  assert.equal(await unlinkPackagePage('monthly-packages'), 2);
  const byId = Object.fromEntries((await readPackages()).map(item => [item.id, item.pages]));
  assert.deepEqual(byId, { starter: ['one-time-packages'], second: [], third: ['one-time-packages'] });
  assert.equal(await unlinkPackagePage('monthly-packages'), 0, 'repeating the delete is harmless');
  await assert.rejects(unlinkPackagePage('Bad Slug'), /valid website page/);
});

const runBackfill = (args = []) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'backfillPackagePages.js'), ...args], { env: { ...process.env, MONGODB_URI: uri } }, (error, stdout) => error ? reject(error) : resolve(stdout)));

test('backfill puts only packages without pages on the One-Time page, dry run first', async () => {
  await seedStarterPackages(Catalogue);
  await Catalogue.updateOne({ _id: 'packages' }, { $set: { 'packages.starter-plus.pages': [] } });
  const dry = await runBackfill();
  assert.match(dry, /DRY RUN/); assert.match(dry, /Packages without a page: 2/);
  assert.equal((await readPackages()).filter(item => item.pages).length, 1, 'dry run writes nothing');
  await runBackfill(['--apply']);
  const byId = Object.fromEntries((await readPackages()).map(item => [item.id, item.pages]));
  assert.deepEqual(byId, { starter: ['one-time-packages'], 'starter-plus': [], 'starter-complete': ['one-time-packages'] }, 'an admin choice of no page is kept');
  assert.match(await runBackfill(['--apply']), /Packages without a page: 0/);
});
