// The website server's own key for public catalogue reads (salesBackend(false) in
// merasoftware/src/lib/sales-catalogue-server.ts sends "Authorization: Bearer <secret>").
// One check for every /api/integration/* route.
const { timingSafeEqual } = require('node:crypto');

const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };

function requireIntegration(req) {
  const secret = process.env.PORTFOLIO_INTEGRATION_SECRET || '';
  if (secret.length < 32) fail('Sales integration is not configured', 503);
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.get('authorization') || '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('Unauthorized integration', 401);
}

module.exports = { requireIntegration };
