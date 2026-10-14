const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'token';
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function sessionSecret() {
  const secret = process.env.TOKEN_SECRET_KEY;
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('TOKEN_SECRET_KEY must be configured');
  }
  // Preserve the exact configured bytes; trimming here would invalidate existing tokens.
  return secret;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  };
}

function issueSession(res, claims) {
  const token = jwt.sign(claims, sessionSecret(), { algorithm: 'HS256', expiresIn: '365d' });
  clearLegacyHostCookie(res);
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
  return token;
}

function verifySession(token) {
  return jwt.verify(token, sessionSecret(), { algorithms: ['HS256'] });
}

function clearSession(res) {
  clearLegacyHostCookie(res);
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

function clearLegacyHostCookie(res) {
  // Before shared-domain login, the API issued host-only cookies. They coexist
  // with the shared cookie and can be chosen first by cookie-parser. Clearing
  // the shared cookie alone neither replaces nor logs out that legacy session.
  const { domain, ...hostOptions } = cookieOptions();
  if (domain) res.clearCookie(COOKIE_NAME, hostOptions);
}

// A closed list prevents unexpected JWT errors from leaking tokens or configuration.
function rejectionReason(error) {
  if (error?.name === 'TokenExpiredError') return 'expired';
  if (error?.name === 'NotBeforeError') return 'not_active';
  if (error?.message === 'invalid signature') return 'invalid_signature';
  if (error?.message === 'invalid algorithm') return 'invalid_algorithm';
  if (['jwt malformed', 'invalid token', 'jwt must be a string'].includes(error?.message)) return 'malformed';
  return 'verification_failed';
}

module.exports = { COOKIE_NAME, sessionSecret, cookieOptions, issueSession, verifySession, clearSession, rejectionReason };
