const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');
const signinController = require('../controller/user/userSignIn');
const authToken = require('../middleware/authToken');
const { issueSession, verifySession, clearSession, sessionSecret, rejectionReason } = require('../helpers/sessionToken');

const originalSecret = process.env.TOKEN_SECRET_KEY;
const originalDomain = process.env.COOKIE_DOMAIN;
let server;
let base;

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'isolated-session-regression-test-secret';
  process.env.COOKIE_DOMAIN = '.merasoftware.com';
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.post('/real-signin', signinController);
  app.get('/real-user-details', authToken, (req, res) => res.json({ id: req.userId, role: req.userRole }));
  app.get('/signin/:id', (req, res) => {
    const token = issueSession(res, { _id: req.params.id, role: 'customer' });
    res.json({ token });
  });
  app.get('/user-details', (req, res) => {
    try { res.json(verifySession(req.cookies.token)); }
    catch (error) { res.status(401).json({ reason: rejectionReason(error) }); }
  });
  app.get('/logout', (req, res) => { clearSession(res); res.json({ success: true }); });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (originalSecret === undefined) delete process.env.TOKEN_SECRET_KEY;
  else process.env.TOKEN_SECRET_KEY = originalSecret;
  if (originalDomain === undefined) delete process.env.COOKIE_DOMAIN;
  else process.env.COOKIE_DOMAIN = originalDomain;
});

test('signin cookie survives HTTP serialization and cookie-parser verification', async () => {
  const signin = await fetch(`${base}/signin/account-a`);
  const setCookie = signin.headers.getSetCookie().find(value => /^token=[^;]/.test(value));
  const legacyClear = signin.headers.getSetCookie().find(value => value.startsWith('token=;'));
  assert.ok(legacyClear, 'signin clears the legacy API host-only cookie');
  assert.doesNotMatch(legacyClear, /Domain=/i);
  assert.match(legacyClear, /Expires=Thu, 01 Jan 1970/);
  const { token } = await signin.json();
  assert.equal(setCookie.split(';')[0], `token=${token}`);
  assert.match(setCookie, /Domain=\.merasoftware\.com/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=None/i);
  const details = await fetch(`${base}/user-details`, { headers: { cookie: setCookie.split(';')[0] } });
  assert.equal(details.status, 200);
  assert.equal((await details.json())._id, 'account-a');
});

test('logout clears the same cookie scope and the next account verifies', async () => {
  const response = await fetch(`${base}/logout`);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some(value => !/Domain=/i.test(value)), 'logout clears the legacy host-only scope too');
  const cookie = cookies.find(value => /Domain=/i.test(value));
  assert.match(cookie, /^token=;/);
  assert.match(cookie, /Domain=\.merasoftware\.com/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
  const signin = await fetch(`${base}/signin/account-b`);
  const details = await fetch(`${base}/user-details`, {
    headers: { cookie: signin.headers.getSetCookie().find(value => /^token=[^;]/.test(value)).split(';')[0] },
  });
  assert.equal(details.status, 200);
  assert.equal((await details.json())._id, 'account-b');
});

test('different signer configuration is classified without exposing token or key', async () => {
  const token = jwt.sign({ _id: 'account-a' }, 'different-instance-secret', { algorithm: 'HS256' });
  const response = await fetch(`${base}/user-details`, { headers: { cookie: `token=${token}` } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { reason: 'invalid_signature' });
});

test('expired, malformed and disallowed-algorithm tokens have distinct reasons', () => {
  for (const [token, reason] of [
    [jwt.sign({ _id: 'a' }, sessionSecret(), { expiresIn: -1 }), 'expired'],
    ['broken', 'malformed'],
    [jwt.sign({ _id: 'a' }, sessionSecret(), { algorithm: 'HS384' }), 'invalid_algorithm'],
  ]) {
    assert.throws(() => verifySession(token), error => rejectionReason(error) === reason);
  }
  assert.equal(rejectionReason(new Error('secret-sensitive-unexpected-message')), 'verification_failed');
});

test('missing signing configuration fails and configured key bytes stay unchanged', () => {
  const secret = process.env.TOKEN_SECRET_KEY;
  try {
    delete process.env.TOKEN_SECRET_KEY;
    assert.throws(sessionSecret, /TOKEN_SECRET_KEY must be configured/);
    process.env.TOKEN_SECRET_KEY = '   ';
    assert.throws(sessionSecret, /TOKEN_SECRET_KEY must be configured/);
    process.env.TOKEN_SECRET_KEY = ' significant spaces ';
    assert.equal(sessionSecret(), ' significant spaces ');
  } finally { process.env.TOKEN_SECRET_KEY = secret; }
});

test('actual signin controller and auth middleware agree across account switching without a database', async () => {
  const originalFindOne = userModel.findOne;
  const originalFindById = userModel.findById;
  const password = 'isolated-test-password';
  const hash = await bcrypt.hash(password, 4);
  userModel.findOne = ({ email }) => ({ select: async () => ({
    _id: email === 'a@example.invalid' ? 'account-a' : 'account-b',
    email, password: hash, plainPassword: password, roles: ['customer'], isActive: true,
    _doc: { email, roles: ['customer'] },
  }) });
  userModel.findById = () => ({ select: () => ({ lean: async () => ({ isActive: true, isGuest: false }) }) });
  try {
    for (const account of ['a', 'b']) {
      const signin = await fetch(`${base}/real-signin`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${account}@example.invalid`, password }),
      });
      assert.equal((await signin.json()).success, true);
      const details = await fetch(`${base}/real-user-details`, {
        headers: { cookie: signin.headers.getSetCookie().find(value => /^token=[^;]/.test(value)).split(';')[0] },
      });
      assert.equal(details.status, 200);
      assert.deepEqual(await details.json(), { id: `account-${account}`, role: 'customer' });
      await fetch(`${base}/logout`);
    }
  } finally {
    userModel.findOne = originalFindOne;
    userModel.findById = originalFindById;
  }
});
