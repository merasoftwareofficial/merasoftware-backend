const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const { fail } = require('./websitePreviewPolicy');
const ISSUER = 'merasoftware-portal-preview';
function env(name) { const value = process.env[name]; if (!value) fail(`Website preview is not configured (${name})`, 503); return value.replace(/\\n/g, '\n'); }
function signCapability(payload, audience, seconds) {
  return jwt.sign(payload, env('WEBSITE_PREVIEW_PRIVATE_KEY'), { algorithm: 'ES256', issuer: ISSUER, audience, expiresIn: seconds });
}
function verifyCapability(token, audience) {
  try { return jwt.verify(token, env('WEBSITE_PREVIEW_PUBLIC_KEY'), { algorithms: ['ES256'], issuer: ISSUER, audience }); }
  catch (error) { if (error.status === 503) throw error; fail('Preview permission is invalid or expired', 401); }
}
function bodyHash(body) { return createHash('sha256').update(JSON.stringify(body)).digest('hex'); }
function verifyService(req) {
  const secret = env('WEBSITE_PREVIEW_SERVICE_SECRET');
  if (secret.length < 32) fail('Preview service credential is not configured', 503);
  let claims;
  try { claims = jwt.verify(String(req.headers.authorization || '').replace(/^Bearer /, ''), secret,
    { algorithms: ['HS256'], issuer: 'merasoftware-next-preview', audience: 'merasoftware-preview-service' }); }
  catch { fail('Invalid preview service assertion', 401); }
  if (claims.action !== req.params.action || claims.hash !== bodyHash(req.body) || !claims.jti || claims.exp - claims.iat > 30) fail('Invalid preview service scope', 401);
  return claims;
}
module.exports = { signCapability, verifyCapability, verifyService, bodyHash, ISSUER };
