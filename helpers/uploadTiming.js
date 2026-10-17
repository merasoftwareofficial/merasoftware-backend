const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');

// Only numeric diagnostics: never log filenames, notes, tokens or account IDs.
function createUploadTiming({ now = () => performance.now(), emit = record => console.info('[upload-timing]', JSON.stringify(record)), surface = 'portal' } = {}) {
  const start = now();
  const events = [];
  let finished = false;
  const elapsed = since => Math.round((now() - since) * 100) / 100;
  return {
    id: randomUUID(),
    mark(stage) { if (!finished) events.push({ stage, atMs: elapsed(start) }); },
    async measure(stage, operation, details = {}) {
      const before = now();
      let ok = false;
      try { const result = await operation(); ok = true; return result; }
      finally { if (!finished) events.push({ stage, durationMs: elapsed(before), ok, ...details }); }
    },
    finish(details = {}) {
      if (finished) return;
      finished = true;
      emit({ id: this.id, surface, totalMs: elapsed(start), events, ...details });
    },
  };
}

function uploadTimingMiddleware(req, res, next) {
  if (process.env.UPLOAD_TIMING_ENABLED !== 'true' || req.method !== 'POST'
      || !['/api/user-request-update', '/api/external-upload/submit'].includes(req.path)) return next();
  const timing = createUploadTiming({ surface: req.path.includes('external-upload') ? 'external' : 'portal' });
  req.uploadTiming = timing;
  res.setHeader('X-Upload-Timing-Id', timing.id);
  req.once('end', () => timing.mark('request_body_received'));
  const complete = outcome => timing.finish({
    outcome, status: res.statusCode,
    fileCount: req.files?.length || 0,
    fileBytes: (req.files || []).reduce((sum, file) => sum + file.size, 0),
  });
  res.once('finish', () => complete('response_finished'));
  res.once('close', () => { if (!res.writableFinished) complete('connection_closed'); });
  next();
}

const measureUpload = (timing, stage, operation, details) => timing
  ? timing.measure(stage, operation, details) : operation();

module.exports = { createUploadTiming, uploadTimingMiddleware, measureUpload };
