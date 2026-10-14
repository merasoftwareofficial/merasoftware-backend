const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { firefox } = require('playwright');
const session = require('../helpers/sessionToken');

const originalSecret = process.env.TOKEN_SECRET_KEY;
const originalDomain = process.env.COOKIE_DOMAIN;
let server;
let browser;
const origin = 'https://api.merasoftware.com';

before(async () => {
  process.env.TOKEN_SECRET_KEY = 'browser-regression-test-only';
  process.env.COOKIE_DOMAIN = '.merasoftware.com';
  const app = express();
  app.use(cookieParser());
  app.get('/legacy-signin', (req, res) => {
    const token = jwt.sign({ _id: 'new-account' }, session.sessionSecret());
    res.cookie('token', token, session.cookieOptions()).json({ success: true });
  });
  app.get('/legacy-logout', (req, res) => {
    res.clearCookie('token', session.cookieOptions()).json({ success: true });
  });
  app.get('/signin/:id', (req, res) => {
    session.issueSession(res, { _id: req.params.id, role: 'customer' });
    res.json({ success: true });
  });
  app.get('/logout', (req, res) => { session.clearSession(res); res.json({ success: true }); });
  app.get('/details', (req, res) => {
    try { res.json({ id: session.verifySession(req.cookies.token)._id }); }
    catch (error) { res.status(401).json({ reason: session.rejectionReason(error) }); }
  });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  browser = await firefox.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (originalSecret === undefined) delete process.env.TOKEN_SECRET_KEY;
  else process.env.TOKEN_SECRET_KEY = originalSecret;
  if (originalDomain === undefined) delete process.env.COOKIE_DOMAIN;
  else process.env.COOKIE_DOMAIN = originalDomain;
});

async function fixture() {
  const context = await browser.newContext();
  // Every browser request is intercepted. No production request or account is used.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const headers = await route.request().allHeaders();
    const response = await context.request.get(
      `http://127.0.0.1:${server.address().port}${url.pathname}`,
      { headers: { cookie: headers.cookie || '' } },
    );
    await route.fulfill({ response });
  });
  const seedLegacy = () => context.addCookies([{
    name: 'token', value: 'invalid-legacy-token', url: `${origin}/`,
    secure: true, httpOnly: true, sameSite: 'None',
  }]);
  const tokens = async () => (await context.cookies(origin)).filter(cookie => cookie.name === 'token');
  return { context, page: await context.newPage(), seedLegacy, tokens };
}

test('old cookie handling reproduces fresh signin rejection and incomplete logout', async () => {
  const f = await fixture();
  try {
    await f.seedLegacy();
    await f.page.goto(`${origin}/legacy-signin`);
    assert.equal((await f.tokens()).length, 2);
    const details = await f.page.goto(`${origin}/details`);
    assert.equal(details.status(), 401);
    await f.page.goto(`${origin}/legacy-logout`);
    assert.deepEqual((await f.tokens()).map(cookie => cookie.domain), ['api.merasoftware.com']);
  } finally { await f.context.close(); }
});

test('fixed signin replaces legacy scope and logout clears both scopes across account switching', async () => {
  const f = await fixture();
  try {
    for (const id of ['account-a', 'account-b', 'account-a']) {
      await f.seedLegacy();
      await f.page.goto(`${origin}/signin/${id}`);
      assert.deepEqual((await f.tokens()).map(cookie => cookie.domain), ['.merasoftware.com']);
      const details = await f.page.goto(`${origin}/details`);
      assert.equal(details.status(), 200);
      assert.deepEqual(await details.json(), { id });
      await f.seedLegacy();
      await f.page.goto(`${origin}/logout`);
      assert.equal((await f.tokens()).length, 0);
    }
  } finally { await f.context.close(); }
});
