const crypto = require('node:crypto');
const { Broadcast, BroadcastRecipient: Recipient, BroadcastGate: Gate } = require('../models/broadcastModel');
const { Queue, State, Lock, STATE_ID, finishedExpiry } = require('../whatsapp/src/models.js');
const { effectiveSettings, inQuietHours } = require('../whatsapp/src/settings.js');
const { loadConfig } = require('../whatsapp/src/config.js');
const { stoppedReason } = require('./whatsappReadiness');
const { enqueueWhatsApp } = require('./whatsappQueue');
const { audience, eligible } = require('./broadcastAudience');
const { decode, render } = require('./broadcastContent');
const { completeAcceptance } = require('./broadcastService');
const ACTIVE = ['waiting', 'releasing', 'pending', 'sending'];
const QUEUED = ['releasing', 'pending', 'sending'];

async function reconcile() {
  for (const recipient of await Recipient.find({ state: { $in: QUEUED } }).lean()) {
    const queued = await Queue.findById(recipient._id).lean();
    if (!queued) {
      if (recipient.queuedAt) await Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'expired', reason: 'Queue record is no longer available; not resent automatically.' } });
      continue; // a releasing recipient without queuedAt is recovered through the persistent gate
    }
    const broadcast = await Broadcast.findById(recipient.broadcastId).lean();
    if (queued.status === 'pending' && (!broadcast || !await eligible(broadcast.audience, recipient))) {
      // Compare-and-set: do not cancel a row the real sender has already claimed.
      await Queue.updateOne({ _id: queued._id, status: 'pending' }, { $set: { status: 'cancelled', lastError: 'Lead left the selected group or its number changed.', expiresAt: finishedExpiry(new Date()) } });
    }
    const latest = await Queue.findById(recipient._id).lean();
    if (latest) await Recipient.updateOne({ _id: recipient._id }, { $set: { state: latest.status, queuedAt: recipient.queuedAt || latest.createdAt, reason: latest.lastError || '', ...(latest.sentAt ? { sentAt: latest.sentAt } : {}) } });
  }
  // A finished send stays in Broadcast history even after the shared queue TTL.
  for (const row of await Broadcast.find({ state: 'ready' }).select('_id').lean()) {
    if (!await Recipient.exists({ broadcastId: row._id, state: { $in: ACTIVE } })) {
      await Broadcast.updateOne({ _id: row._id, state: 'ready' }, { $set: { state: 'finished', finishedAt: new Date() } });
    }
  }
}

async function dispatch({ now = new Date() } = {}) {
  if (process.env.BROADCAST_JOBS_ENABLED !== 'true') return { reason: 'disabled' };
  const owner = crypto.randomUUID();
  // Lease makes recovery possible; the persistent gate + queue uniqueness fence stale claimants.
  try {
    await Lock.updateOne({ _id: 'broadcast-dispatch', $or: [{ expiresAt: { $lte: now } }, { owner }] }, { $set: { owner, expiresAt: new Date(now.getTime() + 120000) } }, { upsert: true });
  } catch (error) { if (error.code === 11000) return { reason: 'busy' }; throw error; }
  const ownsLease = () => Lock.exists({ _id: 'broadcast-dispatch', owner, expiresAt: { $gt: new Date() } });
  const renew = setInterval(() => { Lock.updateOne({ _id: 'broadcast-dispatch', owner }, { $set: { expiresAt: new Date(Date.now() + 120000) } }).catch(() => {}); }, 30000);
  renew.unref?.();
  try {
    await reconcile();
    // Prepare only one accepted broadcast per tick. Preparation is replayable after a crash.
    const preparing = await Broadcast.findOne({ state: 'preparing' }).sort({ createdAt: 1 }).lean();
    if (preparing) {
      await completeAcceptance(preparing);
      const { recipients } = await audience(preparing.audience);
      for (const recipient of recipients) {
        if (!await ownsLease()) return { reason: 'lease-lost' };
        await Recipient.updateOne({ broadcastId: preparing._id, phone: recipient.phone }, { $setOnInsert: { broadcastId: preparing._id, leadId: recipient.leadId, phone: recipient.phone, state: 'waiting' } }, { upsert: true });
      }
      if (!await ownsLease()) return { reason: 'lease-lost' };
      const total = await Recipient.countDocuments({ broadcastId: preparing._id });
      await Broadcast.updateOne({ _id: preparing._id, state: 'preparing' }, { $set: { state: 'ready', total } });
    }
    const state = await State.findById(STATE_ID).lean();
    const stopped = stoppedReason(state, now);
    if (stopped) return { reason: stopped };
    if (inQuietHours(effectiveSettings(state?.settings), now, loadConfig().timeZone)) return { reason: 'quiet-hours' };
    await Gate.updateOne({ _id: 'main' }, { $setOnInsert: { _id: 'main' } }, { upsert: true });
    let gate = await Gate.findById('main').lean();
    if (gate.recipientId) {
      const held = await Recipient.findById(gate.recipientId).lean();
      if (!held || !ACTIVE.includes(held.state)) {
        await Gate.updateOne({ _id: 'main', recipientId: gate.recipientId }, { $unset: { recipientId: 1 } });
        gate = await Gate.findById('main').lean();
      }
    }
    if (await Queue.exists({ status: { $in: ['pending', 'sending'] }, broadcastRecipientId: { $exists: true } })) return { reason: 'broadcast-in-queue' };
    if (await Queue.exists({ status: 'pending', nextAttemptAt: { $lte: now }, broadcastRecipientId: { $exists: false } })) return { reason: 'service-first' };
    if (!gate.recipientId) {
      const readyIds = await Broadcast.find({ state: 'ready' }).distinct('_id');
      const next = await Recipient.findOne({ state: 'waiting', broadcastId: { $in: readyIds } }).sort({ createdAt: 1, _id: 1 }).lean();
      if (!next) return { reason: 'empty' };
      await Gate.updateOne({ _id: 'main', recipientId: { $exists: false } }, { $set: { recipientId: next._id } });
      gate = await Gate.findById('main').lean();
    }
    const recipient = await Recipient.findById(gate.recipientId).lean();
    if (!recipient || !['waiting', 'releasing'].includes(recipient.state)) return { reason: 'waiting' };
    const broadcast = await Broadcast.findById(recipient.broadcastId).lean();
    const lead = broadcast && await eligible(broadcast.audience, recipient);
    if (!lead) {
      await Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'skipped', reason: 'Lead left the selected group or its number changed.' } });
      return { reason: 'skipped' };
    }
    if (!await ownsLease()) return { reason: 'lease-lost' };
    const text = recipient.queueText || render(decode(broadcast.message), { name: lead.name });
    // Store exactly what this recipient will get before enqueue, so a crash uses the same text.
    await Recipient.updateOne({ _id: recipient._id, state: { $in: ['waiting', 'releasing'] } }, { $set: { state: 'releasing', queueText: text } });
    try {
      await enqueueWhatsApp({ _id: recipient._id, broadcastRecipientId: recipient._id, to: recipient.phone, text, event: 'broadcast.manual', application: 'website' });
    } catch (error) { if (error.code !== 11000) throw error; }
    // Recover the actual outcome if the worker claimed it immediately.
    const queued = await Queue.findById(recipient._id).lean();
    await Recipient.updateOne({ _id: recipient._id }, { $set: { state: queued.status, queuedAt: queued.createdAt, reason: queued.lastError || '', ...(queued.sentAt ? { sentAt: queued.sentAt } : {}) } });
    return { reason: 'queued', recipientId: recipient._id };
  } finally {
    clearInterval(renew);
    await Lock.updateOne({ _id: 'broadcast-dispatch', owner }, { $set: { expiresAt: new Date(0) } });
  }
}
module.exports = { dispatch, reconcile };
