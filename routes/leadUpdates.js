const { createLeadUpdates } = require('../helpers/leadUpdates');
const User = require('../models/userModel');
const { COOKIE_NAME, verifySession } = require('../helpers/sessionToken');
const hub = createLeadUpdates();
async function allowed(req) {
  const claims = verifySession(req.cookies?.[COOKIE_NAME]);
  if (claims.role !== 'admin' || String(claims._id) !== String(req.userId)) return false;
  return !!await User.exists({ _id: req.userId, roles: 'admin', isGuest: { $ne: true }, isActive: { $ne: false } });
}
module.exports = async function leadUpdates(req, res) {
  let unsubscribe, heartbeat, checking = false, closed = false;
  const stop = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe?.(); if (!res.writableEnded) res.end(); };
  const send = message => {
    if (closed) return;
    if (res.destroyed || res.writableEnded) { stop(); return; }
    if (!res.write(`data: ${JSON.stringify(message)}\n\n`)) stop();
    if (message.type === 'unavailable') stop();
  };
  try {
    if (!await allowed(req)) return res.status(403).json({ success: false, message: 'Admin access required' });
    // Subscribe before sending SSE headers so unsupported/unavailable deployments fail honestly.
    unsubscribe = await hub.subscribe(send);
    if (req.destroyed || res.destroyed) { unsubscribe(); return; }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    send({ type: 'ready' });
    res.on('close', stop);
    res.on('error', stop);
    heartbeat = setInterval(async () => {
      if (checking || closed) return;
      checking = true;
      try {
        if (!await allowed(req)) { send({ type: 'denied' }); stop(); }
        else if (!res.write(': keepalive\n\n')) stop();
      } catch { stop(); }
      finally { checking = false; }
    }, 30000);
    heartbeat.unref?.();
  } catch {
    unsubscribe?.();
    if (!res.headersSent) res.status(503).json({ success: false, message: 'Live lead updates unavailable. Refresh to retry.' });
    else stop();
  }
};
