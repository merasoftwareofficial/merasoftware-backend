const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const leadTiming = require('../helpers/leadTiming');

function run(method, path) {
  const logged = [];
  const original = console.info;
  console.info = (...args) => logged.push(args.join(' '));
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  let nexted = false;
  leadTiming({ method, path }, res, () => { nexted = true; });
  res.emit('finish');
  console.info = original;
  assert.equal(nexted, true);
  return logged;
}

test('stays silent unless switched on', () => {
  delete process.env.LEAD_TIMING_ENABLED;
  assert.deepEqual(run('GET', '/api/admin/leads'), []);
});

test('logs numbers and the route name, never the lead id', () => {
  process.env.LEAD_TIMING_ENABLED = 'true';
  const [line] = run('GET', '/api/admin/leads/66aa00112233445566778899');
  assert.match(line, /"route":"lead"/);
  assert.doesNotMatch(line, /66aa/);
  assert.equal(run('POST', '/api/admin/leads').length, 0);
  assert.equal(run('GET', '/api/admin/clients').length, 0);
  delete process.env.LEAD_TIMING_ENABLED;
});
