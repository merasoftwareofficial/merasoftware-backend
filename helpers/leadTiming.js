const { performance } = require('node:perf_hooks');

const ROUTES = [[/^\/api\/admin\/leads$/, 'leads'], [/^\/api\/admin\/leads\/[^/]+$/, 'lead'], [/^\/api\/admin\/final-message\/count$/, 'final-count']];

// Numbers only, and only when LEAD_TIMING_ENABLED=true: never a lead id, name or phone.
function leadTiming(req, res, next) {
  const route = req.method === 'GET' && process.env.LEAD_TIMING_ENABLED === 'true' && ROUTES.find(([pattern]) => pattern.test(req.path));
  if (!route) return next();
  const start = performance.now();
  res.once('finish', () => console.info('[lead-timing]', JSON.stringify({ route: route[1], status: res.statusCode, totalMs: Math.round(performance.now() - start) })));
  return next();
}

module.exports = leadTiming;
