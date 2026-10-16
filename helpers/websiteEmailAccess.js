const { createHmac, createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { sessionSecret } = require('./sessionToken');
const signingKey = () => createHmac('sha256', sessionSecret()).update('website-email-control-v1').digest('hex');
const digest = body => createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
function verifyWebsiteAccess(req) {
  const token = req.get('x-website-email-assertion');
  if (!token) return null;
  const claims = jwt.verify(token, signingKey(), { algorithms: ['HS256'], audience: 'email-control', issuer: 'merasoftware-website', maxAge: '60s' });
  if (!['admin', 'intake'].includes(claims.access) || claims.method !== req.method || claims.path !== req.url || claims.digest !== digest(req.body)) throw new Error('Invalid website email access');
  return claims;
}
module.exports = { signingKey, digest, verifyWebsiteAccess };
