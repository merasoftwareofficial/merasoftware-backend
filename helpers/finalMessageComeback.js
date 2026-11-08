const mongoose = require('mongoose');
const Lead = require('../models/leadModel');
const { FinalMessage, Queue } = require('../whatsapp/src/models.js');
const { CONTACTED, DEAD, INQUIRY, WON, leadStatusLabel } = require('./leadStatuses');
const { findLeadsByPhone } = require('./leadPhone');
const { normalizePhone } = require('./whatsappQueue');
const { onNumber } = require('./finalMessageCopies');
const { hasConfirmedName } = require('./leadName');

// Once the countdown ended and the closure message went, the person is Dead for good. Any message they send after
// that closure, of any kind (text, a listed word, an emoji, a reaction, a photo, an ad reply), brings them back as
// Neutral (owner, 8 Nov 2026), as a new request does (leadPhone.js revive, clearClientDead): a client's current status
// is cleared to Neutral; a lead becomes Neutral when we know its name, else Inquiry, because a lead needs a name
// outside the name-optional stages (models/leadModel.js) and the team asks for it there. Everything before the closure
// follows the Final Message rules (finalMessageJobs.js). Run by the minute job, and by Auto Reply before it records
// an ad message, so both agree.
const CAME_BACK = 'Wrote after the closure message.';
// Message times come in whole seconds, the closure's in milliseconds. A reply before the closure stops it going
// (stopFinalMessage.js claimHandoff), so a message in the closure's own second came after it.
const SECOND = 999;

/** When the first closure copy was sent, kept on the cycle: the queue forgets it 30 days after. */
async function closureSentAt(row) {
  if (row.expirySentAt) return row.expirySentAt;
  if (!row.expiryQueuedAt) return null;
  const sent = await Queue.find({ finalMessageExpiryId: row.draftId, status: 'sent' }).select('sentAt updatedAt').lean();
  if (!sent.length) return null;
  const at = new Date(Math.min(...sent.map(item => (item.sentAt || item.updatedAt).getTime())));
  await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId, expirySentAt: null }, { $set: { expirySentAt: at } });
  return at;
}

/** The newest message noted after the closure, a reply or an ignored one alike, or null. */
function messageAfter(row, closure) {
  const messages = [[row.lastReplyAt, row.lastReplyText], [row.lastIgnoredAt, row.lastIgnoredText]]
    .filter(([at]) => at && at.getTime() + SECOND >= closure.getTime())
    .sort(([a], [b]) => b - a);
  return messages.length ? { at: messages[0][0], text: messages[0][1] || 'Message' } : null;
}

const timelineEntry = (note, badge, date) => ({ note, badge, date, createdAt: date });

/** Why this person can't come back from this cycle, or null when they can. The admin may have moved them already. */
function blocked(lead, row) {
  if (!lead || lead.deletedAt) return 'Moved to Trash';
  if (normalizePhone(lead.phone) !== row.phone) return 'Phone number changed';
  if (row.subjectKind === 'client') {
    if (lead.status !== WON || String(lead.convertedToUserId) !== String(row.clientId)) return 'Client link changed';
    if (lead.clientBehaviour !== DEAD || (lead.clientBehaviourRevision || 0) !== (row.behaviourRevision || 0)) return `Status changed to ${leadStatusLabel(lead.clientBehaviour || 'Contacted')}`;
    return null;
  }
  if (lead.convertedToUserId) return 'Converted to client';
  return lead.status === DEAD ? null : `Status changed to ${leadStatusLabel(lead.status)}`;
}

/** One Dead cycle after its closure: brings its person back when they wrote. Returns true when they came back. */
async function comeBackIfWrote(row) {
  if (row.status !== 'dead') return false;
  const closure = await closureSentAt(row);
  const message = closure && messageAfter(row, closure);
  if (!message) return false;
  const lead = await Lead.findById(row.leadId).lean();
  const reason = blocked(lead, row);
  const now = new Date();
  if (reason) {
    // Nothing to bring back: the cycle ends so the message isn't looked at again, and the person stays as the admin left them.
    await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId, status: 'dead' }, { $set: { status: 'stopped', stoppedAt: now, stopReason: reason, stopSource: 'status-change' } });
    return false;
  }
  const note = to => `Wrote on WhatsApp after the closure message: ${message.text}\nCame back from Dead to ${leadStatusLabel(to)}.`;
  return mongoose.connection.transaction(async session => {
    const claimed = await FinalMessage.updateOne({ _id: row._id, draftId: row.draftId, status: 'dead' },
      { $set: { status: 'stopped', stoppedAt: now, stopReason: CAME_BACK, stopSource: 'came-back', cameBackAt: message.at, cameBackText: message.text } }, { session });
    if (!claimed.modifiedCount) return false;
    if (row.subjectKind === 'client') {
      // Neutral is no saved value, as leadPhone.js clearClientDead leaves it; the line keeps the client's Won badge, as there.
      const changed = await Lead.updateOne({ _id: lead._id, deletedAt: null, status: WON, convertedToUserId: row.clientId, clientBehaviour: DEAD, clientBehaviourRevision: lead.clientBehaviourRevision ? lead.clientBehaviourRevision : { $in: [null, 0] } },
        { $unset: { clientBehaviour: 1 }, $inc: { clientBehaviourRevision: 1 }, $push: { followUps: timelineEntry(note(CONTACTED), WON, now) } }, { session });
      if (!changed.modifiedCount) throw new Error('Client changed while coming back.');
      return true;
    }
    // Every Dead lead with this number, as the countdown made them Dead together (finalMessageJobs.js closeRow): one left would keep the number blocked.
    const leads = await findLeadsByPhone(row.phone, { status: DEAD, deletedAt: null, convertedToUserId: null }, { session });
    for (const item of leads) {
      const to = hasConfirmedName(item) ? CONTACTED : INQUIRY;
      const changed = await Lead.updateOne({ _id: item._id, status: DEAD }, { $set: { status: to }, $push: { followUps: timelineEntry(note(to), to, now) } }, { session });
      if (String(item._id) === String(row.leadId) && !changed.modifiedCount) throw new Error('Lead changed while coming back.');
    }
    return true;
  });
}

/** Auto Reply's check before it records an ad message from this number (helpers/autoReplyJobs.js). */
async function comeBackByPhone(phone) {
  if (!phone) return false;
  let came = false;
  for (const row of await FinalMessage.find({ ...onNumber(phone), status: 'dead', expiryQueuedAt: { $ne: null } }).lean()) {
    if (await comeBackIfWrote(row)) came = true;
  }
  return came;
}

module.exports = { closureSentAt, comeBackIfWrote, comeBackByPhone };
