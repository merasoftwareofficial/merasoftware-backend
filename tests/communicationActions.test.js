const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIONS, SURFACES, UNSORTED } = require('../helpers/communicationActionCatalog');
const { merge, validatePatch, clean } = require('../helpers/communicationActions');

test('catalog: every action has a unique id, a known surface and a category', () => {
  const ids = ACTIONS.map(action => action.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ACTIONS.length, 178);
  for (const action of ACTIONS) {
    assert.ok(SURFACES.includes(action.surface), action.id);
    assert.ok(action.category, action.id);
    assert.match(action.method, /^(POST|PUT|PATCH|DELETE)$/, action.id);
  }
});

test('catalog: every action is placed; the 12 unclear ones were assigned from their callers', () => {
  assert.deepEqual(UNSORTED, []);
  assert.equal(ACTIONS.filter(action => action.category === 'Unsorted').length, 0);
  const byId = Object.fromEntries(ACTIONS.map(action => [action.id, action]));
  assert.equal(byId.A110.surface, 'Admin');
  assert.equal(byId.B36.surface, 'Admin');
  assert.equal(byId.B37.surface, 'Client');
  assert.equal(byId.A15.surface, 'Website');
  assert.equal(byId.A03.category, 'Website preview');
});

test('merge: no saved change keeps the catalog values', () => {
  const base = ACTIONS[0];
  const row = merge(base, null);
  assert.equal(row.surface, base.surface);
  assert.equal(row.category, base.category);
  assert.equal(row.archived, false);
  assert.equal(row.deleted, false);
  assert.equal(row.changed, false);
});

test('merge: saved surface, category, archive and delete override the catalog', () => {
  const base = ACTIONS[0];
  const row = merge(base, { surface: 'Website', category: 'Orders', archived: true, deleted: false });
  assert.equal(row.surface, 'Website');
  assert.equal(row.category, 'Orders');
  assert.equal(row.archived, true);
  assert.equal(row.changed, true);
});

test('validatePatch: accepts a valid move, archive and delete', () => {
  assert.deepEqual(validatePatch({ surface: 'Client', category: '  Profile  ', archived: true, deleted: false }),
    { surface: 'Client', category: 'Profile', archived: true, deleted: false });
});

test('validatePatch: rejects an unknown surface, an empty category and non-boolean flags', () => {
  assert.throws(() => validatePatch({ surface: 'Other' }), /valid surface/);
  assert.throws(() => validatePatch({ category: '   ' }), /cannot be empty/);
  assert.throws(() => validatePatch({ archived: 'yes' }), /true or false/);
  assert.throws(() => validatePatch({ deleted: 1 }), /true or false/);
});

test('clean: collapses spaces and caps the length', () => {
  assert.equal(clean('  a   b  ', 60), 'a b');
  assert.equal(clean('x'.repeat(100), 60).length, 60);
});

test('categories: every action sits under a known heading, and every heading is used', () => {
  const { NAMES, MEANING_BY_NAME } = require('../helpers/communicationCategories');
  const used = new Set(ACTIONS.map(action => action.category));
  for (const action of ACTIONS) assert.ok(NAMES.includes(action.category), action.id + ' ' + action.category);
  for (const name of NAMES) {
    assert.ok(used.has(name), 'unused heading ' + name);
    assert.ok(MEANING_BY_NAME[name].length > 10, name);
  }
});
