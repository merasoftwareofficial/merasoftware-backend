const service = require('../../helpers/websitePreviewService');
const { Receipt } = require('../../models/websitePreviewModel');
const { verifyService } = require('../../helpers/websitePreviewTokens');
const { isAllowedOrigin } = require('../../config/allowedOrigins');
const { fail } = require('../../helpers/websitePreviewPolicy');
const wrap = fn => async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json({ success: true, data: await fn(req) }); }
  catch (e) { res.status(e.status || (e.code === 11000 ? 409 : 500)).json({ success: false,
    message: e.status ? e.message : e.code === 11000 ? 'Preview hostname or request already exists' : 'Website preview request failed' }); }
};
const browser = fn => wrap(req => {
  if (req.method !== 'GET' && !isAllowedOrigin(req.headers.origin)) fail('Portal origin required', 403);
  return fn(req);
});
exports.state = browser(r => service.state(r.params.projectId, r.userId, r.userRole));
exports.settings = browser(r => service.settings(r.params.projectId, r.userId, r.userRole, r.body));
exports.begin = browser(r => service.begin(r.params.projectId, r.userId, r.userRole, r.body));
exports.batch = browser(r => service.uploadBatch(r.params.projectId, r.params.versionId, r.userId, r.userRole));
exports.grant = browser(r => service.grant(r.params.projectId, r.userId, r.userRole, r.body.nonce));
exports.cleanup = browser(r => service.cleanupClaims(r.params.projectId, r.userId, r.userRole));
exports.integration = wrap(async req => {
  const assertion = verifyService(req);
  try { await Receipt.create({ _id: `service:${assertion.jti}`, expiresAt: new Date(assertion.exp * 1000 + 60_000) }); }
  catch (e) { if (e.code === 11000) fail('Service assertion already used', 409); throw e; }
  const actions = { redeem: () => service.redeem(req.body.token), freeze: () => service.freeze(req.body),
    finish: () => service.finish(req.body), failed: () => service.failed(req.body), 'cleanup-done': () => service.cleanupDone(req.body) };
  if (!actions[req.params.action]) fail('Unknown preview service action', 404);
  return actions[req.params.action]();
});
