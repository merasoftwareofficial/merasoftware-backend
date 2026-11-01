// One committed-change observer per API process. Only bounded identifiers and
// ownership indexes (never responses/records) live while subscribers exist.
const mongoose = require('mongoose');
const domains = require('./resourceDomains');
const Lead = require('../models/leadModel');
const MAX_OWNED = 5000;
function createLeadUpdates(connection = mongoose.connection) {
  const listeners = new Set();
  let stream, starting, flushTimer;
  const byCollection = new Map(domains.map(domain => [domain.collection, domain]));
  function stop() {
    if (listeners.size) return;
    clearTimeout(flushTimer); flushTimer = null;
    const previous = stream; stream = null;
    if (previous) void previous.close().catch(() => {});
  }
  function signal(listener, domain, id) {
    let entry = listener.pending.get(domain);
    if (!entry) { entry = { domain, ids: new Set(), all: false }; listener.pending.set(domain, entry); }
    if (id && entry.ids.size < 200) entry.ids.add(String(id)); else entry.all = true;
  }
  function queue(change) {
    const descriptor = byCollection.get(change.ns.coll);
    if (!descriptor) return;
    if (descriptor.collection === 'whatsapp_state' && change.operationType === 'update') {
      const fields = [...Object.keys(change.updateDescription?.updatedFields || {}), ...(change.updateDescription?.removedFields || [])];
      if (fields.length && fields.every(field => ['heartbeatAt', 'updatedAt'].includes(field))) return;
    }
    const recordId = String(change.documentKey?._id || '');
    const leadId = descriptor.domain === 'leads'
      ? (descriptor.collection === Lead.collection.name ? recordId : change.fullDocument?.leadId) : null;
    for (const listener of listeners) {
      if (!listener.options.portal && descriptor.domain !== 'leads') continue;
      const { userId, role = 'admin' } = listener.options;
      let permitted = role === 'admin';
      if (!permitted) {
        if (!descriptor.owner) continue;
        if (descriptor.owner === '*') permitted = true;
        else {
          const owned = listener.owned.get(descriptor.collection);
          const previous = owned?.has(recordId);
          const current = [descriptor.owner].flat().some(field => String(change.fullDocument?.[field] || '') === String(userId));
          permitted = previous || current;
          if (current) {
            if (!owned.has(recordId) && owned.size >= MAX_OWNED) { listener.failed = true; if (listener.ready) listener.send({ type: 'unavailable' }); continue; }
            owned.add(recordId);
          } else if (change.operationType === 'delete' || change.fullDocument) owned?.delete(recordId);
        }
      }
      if (!permitted) continue;
      const domain = descriptor.domain === 'leads' && role !== 'admin' ? 'referrals' : descriptor.domain;
      signal(listener, domain, domain === 'catalog' && role !== 'admin' ? null : domain === 'leads' ? leadId : recordId);
      // Parent lists subscribe with the authorized owner ID. Do not expose a
      // transferred record's new owner to the previous customer.
      for (const field of ['uploads', 'upload-links', 'orders'].includes(domain) ? [descriptor.owner].flat() : []) {
        const owner = field && field !== '*' ? change.fullDocument?.[field] : null;
        if (owner && (role === 'admin' || String(owner) === String(userId))) signal(listener, domain, owner);
      }
      if (['uploads', 'upload-links'].includes(domain) && change.operationType === 'delete') signal(listener, domain, null);
      if (role === 'admin' && descriptor.domain === 'leads' && descriptor.collection !== Lead.collection.name) signal(listener, 'communication', null);
      // Dependent summaries/lists must reconcile even if event record ID differs.
      const dependencies = {
        referrals: ['documents'], users: ['clients', 'documents', 'wallet'], orders: ['clients'], payments: ['wallet', 'clients', 'orders', 'invoices', 'referrals'],
        invoices: ['clients', 'orders'], updates: ['orders', 'clients'], uploads: ['orders', 'documents'], offers: ['orders'],
      };
      for (const related of dependencies[domain] || []) signal(listener, related, null);
    }
    if (!flushTimer) flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const listener of listeners) {
        if (!listener.ready || !listener.pending.size) continue;
        const resources = [...listener.pending.values()].map(entry => ({ domain: entry.domain, ids: [...entry.ids], all: entry.all }));
        listener.pending.clear();
        const leads = resources.find(entry => entry.domain === 'leads');
        listener.send({ type: 'changed', ids: leads?.ids || [], all: leads?.all || false, resources });
      }
    }, 200);
  }
  async function start() {
    if (stream) return;
    if (starting) return starting;
    starting = (async () => {
      const fields = { _id: 1, ns: 1, documentKey: 1, operationType: 1, updateDescription: 1, 'fullDocument.leadId': 1 };
      for (const descriptor of domains) if (descriptor.owner && descriptor.owner !== '*') for (const field of [descriptor.owner].flat()) fields['fullDocument.' + field] = 1;
      const cursor = connection.db.watch([
        { $match: { 'ns.coll': { $in: [...byCollection.keys()] }, operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
        { $project: fields },
      ], { fullDocument: 'updateLookup', maxAwaitTimeMS: 1000 });
      stream = cursor;
      try { const first = await cursor.tryNext(); if (first) queue(first); }
      catch (error) { stream = null; await cursor.close(); throw error; }
      void (async () => {
        try { for await (const change of cursor) queue(change); }
        catch { /* finally notifies consumers exactly once */ }
        finally {
          if (stream === cursor) { stream = null; for (const listener of [...listeners]) listener.send({ type: 'unavailable' }); }
        }
      })();
    })();
    try { await starting; } finally { starting = null; }
  }
  async function subscribe(send, options = {}) {
    const listener = { send, options, pending: new Map(), owned: new Map(), ready: false };
    for (const descriptor of domains) if (descriptor.owner && descriptor.owner !== '*') listener.owned.set(descriptor.collection, new Set());
    listeners.add(listener);
    try {
      await start();
      // Observer runs before ownership snapshots. New owned inserts/updates are
      // merged, not overwritten; ready reconciliation covers setup-time deletes.
      if (options.role && options.role !== 'admin') {
        await Promise.all(domains.filter(descriptor => descriptor.owner && descriptor.owner !== '*').map(async descriptor => {
          const owned = listener.owned.get(descriptor.collection);
          const rows = await descriptor.model.find({ $or: [descriptor.owner].flat().map(field => ({ [field]: options.userId })) }).select('_id').limit(MAX_OWNED + 1).lean();
          for (const row of rows) owned.add(String(row._id));
          if (owned.size > MAX_OWNED) throw new Error('Live ownership capacity exceeded');
        }));
      }
      if (listener.failed) throw new Error('Live ownership capacity exceeded');
      listener.ready = true; listener.pending.clear();
    } catch (error) { listeners.delete(listener); stop(); throw error; }
    return () => { listeners.delete(listener); listener.pending.clear(); listener.owned.clear(); stop(); };
  }
  return { subscribe };
}
module.exports = { createLeadUpdates };
