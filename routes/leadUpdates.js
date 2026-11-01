const { createLeadUpdates } = require('../helpers/leadUpdates');
const User = require('../models/userModel');
const { COOKIE_NAME, verifySession } = require('../helpers/sessionToken');
const hub = createLeadUpdates();
async function allowed(req, portal) {
  const claims = verifySession(req.cookies?.[COOKIE_NAME]);
  if ((!portal && claims.role !== 'admin') || !['admin', 'customer', 'member'].includes(claims.role) || claims.role !== req.userRole || String(claims._id) !== String(req.userId)) return false;
  return !!await User.exists({ _id: req.userId, roles: claims.role, deletedAt: null, isGuest: { $ne: true }, isActive: { $ne: false } });
}
async function leadUpdates(req, res, portal = false) {
  let unsubscribe, heartbeat, checking = false, closed = false;
  let pendingUpdate = null, sending = false;
  const stop = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe?.(); if (!res.writableEnded) res.end(); };
  const write = message => {
    if (closed) return;
    if (res.destroyed || res.writableEnded) { stop(); return; }
    if (!res.write(`data: ${JSON.stringify(message)}\n\n`)) stop();
    if (message.type === 'unavailable') stop();
  };
  const send = message => {
    if (message.type !== 'changed') { write(message); return; }
    pendingUpdate = pendingUpdate ? { type: 'resync' } : message;
    if (sending) return;
    sending = true;
    void (async () => {
      try {
        while (pendingUpdate && !closed) {
          const current = pendingUpdate; pendingUpdate = null;
          if (!await allowed(req, portal)) { write({ type: 'denied' }); stop(); return; }
          write(current);
        }
      } catch { stop(); }
      finally { sending = false; }
    })();
  };
  try {
    if (!await allowed(req, portal)) return res.status(403).json({ success: false, message: 'Live update access required' });
    // Subscribe before sending SSE headers so unsupported/unavailable deployments fail honestly.
    unsubscribe = await hub.subscribe(send, { portal, userId: req.userId, role: req.userRole });
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
        if (!await allowed(req, portal)) { send({ type: 'denied' }); stop(); }
        else if (!res.write(': keepalive\n\n')) stop();
      } catch { stop(); }
      finally { checking = false; }
    }, 30000);
    heartbeat.unref?.();
  } catch {
    unsubscribe?.();
    if (!res.headersSent) res.status(503).json({ success: false, message: 'Live updates unavailable. Refresh to retry.' });
    else stop();
  }
}
module.exports = (req, res) => leadUpdates(req, res);
module.exports.portal = (req, res) => leadUpdates(req, res, true);
