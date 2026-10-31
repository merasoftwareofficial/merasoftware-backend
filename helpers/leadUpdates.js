// Read-only database observer: sees API, cron and separate WhatsApp worker writes.
// Notifications carry identifiers only. Current records always come from existing APIs.
const mongoose = require('mongoose');
const Lead = require('../models/leadModel');
const OfferTarget = require('../models/offerTargetModel');
const { FinalMessage } = require('../whatsapp/src/models.js');
function createLeadUpdates(connection = mongoose.connection) {
  const listeners = new Set();
  let stream, starting, flushTimer;
  const ids = new Set();
  let all = false;
  const emit = message => { for (const listener of listeners) listener(message); };
  function queue(change) {
    if (!listeners.size) return;
    const id = change.ns.coll === Lead.collection.name ? change.documentKey?._id : change.fullDocument?.leadId;
    if (id && ids.size < 200) ids.add(String(id)); else all = true;
    if (!flushTimer) flushTimer = setTimeout(() => {
      flushTimer = null; emit({ type: 'changed', ids: [...ids], all }); ids.clear(); all = false;
    }, 200);
  }
  async function start() {
    if (stream) return;
    if (starting) return starting;
    starting = (async () => {
      const cursor = connection.db.watch([
        { $match: { 'ns.coll': { $in: [Lead.collection.name, FinalMessage.collection.name, OfferTarget.collection.name] }, operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
        { $project: { _id: 1, ns: 1, documentKey: 1, operationType: 1, 'fullDocument.leadId': 1 } },
      ], { fullDocument: 'updateLookup', maxAwaitTimeMS: 1000 });
      stream = cursor;
      try {
        // Establish the cursor before telling browsers to reconcile their initial GET.
        const first = await cursor.tryNext();
        if (first) queue(first);
      } catch (error) { stream = null; await cursor.close(); throw error; }
      void (async () => {
        try { for await (const change of cursor) queue(change); }
        catch { if (stream === cursor) emit({ type: 'unavailable' }); }
        finally { if (stream === cursor) { stream = null; emit({ type: 'unavailable' }); } }
      })();
    })();
    try { await starting; } finally { starting = null; }
  }
  async function subscribe(listener) {
    listeners.add(listener);
    try { await start(); }
    catch (error) { listeners.delete(listener); throw error; }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        clearTimeout(flushTimer); flushTimer = null; ids.clear(); all = false;
        const previous = stream; stream = null;
        if (previous) void previous.close().catch(() => {});
      }
    };
  }
  return { subscribe };
}
module.exports = { createLeadUpdates };
