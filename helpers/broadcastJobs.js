const crypto = require('node:crypto');
const { Broadcast, BroadcastRecipient: Recipient, BroadcastGate: Gate } = require('../models/broadcastModel');
const { Queue, State, Lock, STATE_ID, finishedExpiry } = require('../whatsapp/src/models.js');
const { effectiveSettings, inQuietHours } = require('../whatsapp/src/settings.js');
const { loadConfig } = require('../whatsapp/src/config.js');
const { stoppedReason } = require('./whatsappReadiness');
const { enqueueWhatsApp } = require('./whatsappQueue');
const { audience, eligible } = require('./broadcastAudience');
const { readComposition, compositionParts, compositionUsesName, compositionHtml, compositionTitle } = require('./broadcastContent');
const { completeAcceptance } = require('./broadcastService');
const ACTIVE = ['waiting', 'releasing', 'pending', 'sending'];
const QUEUED = ['releasing', 'pending', 'sending'];
const nameRule = broadcast => ({ requireName: compositionUsesName(readComposition(broadcast.message)) });

async function reconcile() {
  for (const recipient of await Recipient.find({ channel: { $ne: 'email' }, state: { $in: QUEUED } }).lean()) {
    const queued = await Queue.findById(recipient._id).lean();
    if (!queued) {
      if (recipient.queuedAt) await Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'expired', reason: 'Queue record is no longer available; not resent automatically.' } });
      continue; // a releasing recipient without queuedAt is recovered through the persistent gate
    }
    const broadcast = await Broadcast.findById(recipient.broadcastId).lean();
    if (queued.status === 'pending' && (!broadcast || !await eligible(broadcast.audience, recipient, nameRule(broadcast)))) {
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
      await upgradeRecipientIndex();
      const value = readComposition(preparing.message);
      const { recipients, excluded } = await audience(preparing.audience, { ...nameRule(preparing), channel: preparing.channel || 'whatsapp' });
      for (const recipient of recipients) {
        if (!await ownsLease()) return { reason: 'lease-lost' };
        const channel = recipient.channel || 'whatsapp';
        let parts = 1, invalidContent = '';
        try { if (channel !== 'email') parts = compositionParts(value, { name: recipient.name }).length; }
        catch (error) { invalidContent = error.message; }
        for (let part = 0; part < parts; part++) {
          const key = { broadcastId: preparing._id, channel, ...(channel === 'email' ? { email: recipient.email } : { phone: recipient.phone }), part };
          await Recipient.updateOne(key, { $setOnInsert: { ...key, leadId: recipient.leadId, parts, state: invalidContent ? 'skipped' : 'waiting', reason: invalidContent } }, { upsert: true });
        }
      }
      if (!await ownsLease()) return { reason: 'lease-lost' };
      const total = await Recipient.countDocuments({ broadcastId: preparing._id });
      await Broadcast.updateOne({ _id: preparing._id, state: 'preparing' }, { $set: { state: 'ready', total, excluded } });
    }
    await releaseEmail(ownsLease);
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
      const next = await Recipient.findOne({ channel: { $ne: 'email' }, state: 'waiting', broadcastId: { $in: readyIds } }).sort({ createdAt: 1, part: 1, _id: 1 }).lean();
      if (!next) return { reason: 'empty' };
      await Gate.updateOne({ _id: 'main', recipientId: { $exists: false } }, { $set: { recipientId: next._id } });
      gate = await Gate.findById('main').lean();
    }
    const recipient = await Recipient.findById(gate.recipientId).lean();
    if (!recipient || !['waiting', 'releasing'].includes(recipient.state)) return { reason: 'waiting' };
    const broadcast = await Broadcast.findById(recipient.broadcastId).lean();
    if (recipient.part > 0) {
      const previous = await Recipient.findOne({ broadcastId: recipient.broadcastId, phone: recipient.phone, part: recipient.part - 1 }).lean();
      if (previous?.state !== 'sent') {
        if (previous && !ACTIVE.includes(previous.state)) await Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'cancelled', reason: 'An earlier message part was not sent.' } });
        await Gate.updateOne({ _id: 'main', recipientId: recipient._id }, { $unset: { recipientId: 1 } });
        return { reason: 'previous-part' };
      }
    }
    const lead = broadcast && await eligible(broadcast.audience, recipient, nameRule(broadcast));
    if (!lead) {
      await Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'skipped', reason: 'Lead left the selected group or its number changed.' } });
      return { reason: 'skipped' };
    }
    if (!await ownsLease()) return { reason: 'lease-lost' };
    let part;
    try { part = compositionParts(readComposition(broadcast.message), { name: lead.name })[recipient.part || 0]; }
    catch (error) {
      await Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'skipped', reason: error.message } });
      return { reason: 'invalid-personalization' };
    }
    const text = recipient.queueText ?? part.text;
    // Store exactly what this recipient will get before enqueue, so a crash uses the same text.
    await Recipient.updateOne({ _id: recipient._id, state: { $in: ['waiting', 'releasing'] } }, { $set: { state: 'releasing', queueText: text } });
    try {
      await enqueueWhatsApp({ _id: recipient._id, broadcastRecipientId: recipient._id, to: recipient.phone, text, ...(part.media ? { media: part.media } : {}), event: 'broadcast.manual', application: 'website',
        ...(require('./whatsappQueue').normalizePhone(lead.phone) !== recipient.phone ? { alt: true } : {}) });
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
// Replace only the obsolete recipient uniqueness constraint, after building its replacement.
// Existing records have implicit WhatsApp/part 0 defaults and keep their IDs/queue references.
async function upgradeRecipientIndex() {
  const indexes = await Recipient.collection.indexes().catch(error => { if (error.code === 26) return []; throw error; });
  if (indexes.some(index => index.name === 'broadcastId_1_phone_1')) {
    await Recipient.updateMany({ channel: { $exists: false } }, { $set: { channel: 'whatsapp', part: 0, parts: 1 } });
    await Recipient.collection.createIndex({ broadcastId: 1, channel: 1, phone: 1, email: 1, part: 1 }, { unique: true });
    await Recipient.collection.dropIndex('broadcastId_1_phone_1');
  }
}
async function releaseEmail(ownsLease) {
  const readyIds = await Broadcast.find({ state: 'ready' }).distinct('_id');
  const recipient = await Recipient.findOne({ channel: 'email', state: { $in: ['waiting', 'releasing'] }, broadcastId: { $in: readyIds } }).sort({ createdAt: 1, part: 1, _id: 1 }).lean();
  if (!recipient || !await ownsLease()) return;
  const broadcast = await Broadcast.findById(recipient.broadcastId).lean();
  const lead = await eligible(broadcast.audience, recipient, nameRule(broadcast));
  if (!lead) return Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'skipped', reason: 'Person left the group, was blocked or their email changed.' } });
  const { EmailDraft, EmailHistory } = require('../models/emailControlModel');
  const { reconcileSent } = require('./emailOutbox');
  await reconcileSent({ draftId: recipient._id });
  let draft = await EmailDraft.findById(recipient._id).lean();
  if (draft?.status === 'sending') {
    // Provider outcome is uncertain; never automatically resend after its idempotency window.
    return Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'failed', reason: 'Email delivery was interrupted; check Email history before retrying.' } });
  }
  if (!draft) {
    const value = readComposition(broadcast.message), values = { name: lead.name };
    let parts;
    try { parts = compositionParts(value, values); }
    catch (error) { return Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'skipped', reason: error.message } }); }
    const plain = parts.map(part => [part.text, part.media?.url].filter(Boolean).join('\n')).join('\n\n');
    draft = await EmailDraft.findOneAndUpdate({ _id: recipient._id }, { $setOnInsert: {
      event: 'broadcast.manual', application: 'portal', actor: broadcast.createdBy, to: [recipient.email],
      subject: value.subject || compositionTitle(value), text: plain, plain, html: compositionHtml(value, values),
      delivery: { channels: ['email'], lockedAt: new Date(), subject: value.subject || compositionTitle(value), text: plain, emailStatus: 'pending', whatsappStatus: 'not-selected' },
      status: 'pending', expiresAt: new Date(Date.now() + 30 * 86400000), source: 'broadcast',
    } }, { upsert: true, new: true });
  }
  await Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'releasing', emailDraftId: draft._id } });
  try {
    const accepted = draft.status === 'sent' || await EmailHistory.exists({ draftId: draft._id, status: 'sent', providerId: { $nin: [null, ''] } });
    if (!accepted) await require('./emailController').decide(String(draft._id), broadcast.createdBy, { choice: 'send', channels: 'email', subject: draft.subject, text: draft.text }, { application: 'portal', portalAdmin: true, broadcastDelivery: true });
    const result = await EmailDraft.findById(draft._id).lean();
    await Recipient.updateOne({ _id: recipient._id }, { $set: { state: result.status === 'sent' ? 'sent' : 'failed', sentAt: result.sentAt, reason: result.failure || '' } });
  } catch (error) {
    await Recipient.updateOne({ _id: recipient._id }, { $set: { state: 'failed', reason: error.message } });
  }
}
module.exports = { dispatch, reconcile, upgradeRecipientIndex };
