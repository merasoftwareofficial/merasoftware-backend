const mongoose = require('mongoose');
const Lead = require('../models/leadModel');
const { FinalMessage } = require('../whatsapp/src/models.js');
const { normalizePhone, enqueueWhatsApp } = require('./whatsappQueue');

const EVENT = 'lead.finalMessageExpired';
const CANCELLED = 'Not sent: the final message cycle, recipient or reply status changed.';
const hasReply = row => row.lastReplyAt && row.sentAt && row.lastReplyAt >= row.sentAt;

// Used both by the scheduler and immediately before the worker sends (after typing).
async function eligible(row) {
  if (process.env.ENABLE_WHATSAPP !== 'true' || !row?.expiryEnabled || row.status !== 'dead' || hasReply(row) || !row.originalMessage?.id) return false;
  if (await require('./stopFinalMessage').processOutbound(row) !== 'clear') return false;
  const lead = await Lead.findById(row.leadId).lean();
  if (!lead || lead.deletedAt || normalizePhone(lead.phone) !== row.phone) return false;
  if (row.subjectKind === 'client') {
    const { clientEligible } = require('./finalMessage');
    return lead.clientBehaviour === 'Dead' && clientEligible({ ...lead, clientBehaviour: 'Negative' }, row);
  }
  return lead.status === 'Dead' && !lead.convertedToUserId && !lead.requestedByUserId;
}

async function canSend(item) {
  if (!item.finalMessageExpiryId) {
    if (item.event !== 'lead.finalMessage' || !item.emailDraftId) return true;
    const original = await FinalMessage.findOne({ draftId: item.emailDraftId }).lean();
    if (!original) return true; // an ordinary, untracked message using this template
    if (!['review', 'queued'].includes(original.status)) return false;
    if (await require('./stopFinalMessage').processOutbound(original) !== 'clear') return false;
    if (original.subjectKind !== 'client') return true;
    const lead = await Lead.findById(original.leadId).lean();
    return (await require('./clientFinalMessageReadiness').clientReadiness(lead, original)).ready;
  }
  const row = await FinalMessage.findOne({ draftId: item.finalMessageExpiryId }).lean();
  if (!row || row.phone !== item.to || !await eligible(row)) return false;
  const { EmailPolicy } = require('../models/emailControlModel');
  return (await EmailPolicy.findOne({ event: EVENT }).lean())?.mode !== 'off';
}

// The closed cycle is a durable outbox. Queue insertion and its permanent marker commit together.
// Queue TTL therefore cannot cause another expiry message; a crash before commit retries next minute.
async function dispatch() {
  const { applyDefault } = require('./emailController');
  for (const row of await FinalMessage.find({ status: 'dead', expiryEnabled: true, expiryQueuedAt: null }).lean()) {
    if (!await eligible(row)) continue;
    const mail = await applyDefault(EVENT, {}, {});
    if (!mail?.plain?.trim()) continue;
    await mongoose.connection.transaction(async session => {
      const claimed = await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId, status: 'dead', expiryQueuedAt: null, 'outboundChecks.0': { $exists: false },
        $or: [{ lastReplyAt: null }, { lastReplyAt: { $lt: row.sentAt } }] }, { $set: { expiryQueuedAt: new Date() } }, { session });
      if (!claimed.modifiedCount) return;
      await enqueueWhatsApp({ to: row.phone, text: mail.plain, event: EVENT, application: 'portal',
        finalMessageExpiryId: row.draftId, quotedMessage: row.originalMessage }, { session });
    });
  }
}

module.exports = { EVENT, CANCELLED, canSend, dispatch };
