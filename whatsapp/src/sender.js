import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { SLOT_MS, STATE_ID, OutgoingAttempt, finishedExpiry } from './models.js';
import { generateMessageIDV2 } from '@whiskeysockets/baileys';
import { effectiveSettings, inQuietHours, typingTime } from './settings.js';
import expiry from '../../helpers/finalMessageExpiry.js';
import stopFinalMessage from '../../helpers/stopFinalMessage.js';
import whatsappQueue from '../../helpers/whatsappQueue.js';
import contacts from '../../helpers/contactNumbers.js';

const INTERRUPTED = 'The service restarted while sending this message, so it may or may not have arrived. Not sent again automatically, to avoid a duplicate.';
async function broadcastEligible(item) {
  if (!item.broadcastRecipientId) return true;
  const { Broadcast, BroadcastRecipient } = await import('../../models/broadcastModel.js').then(value => value.default);
  const recipient = await BroadcastRecipient.findById(item.broadcastRecipientId).lean();
  const broadcast = recipient && await Broadcast.findById(recipient.broadcastId).lean();
  if (!broadcast) return false;
  const content = await import('../../helpers/broadcastContent.js').then(value => value.default);
  const audience = await import('../../helpers/broadcastAudience.js').then(value => value.default);
  return !!await audience.eligible(broadcast.audience, recipient, { requireName: content.compositionUsesName(content.readComposition(broadcast.message)) });
}
const NOT_ON_WHATSAPP = 'This number is not on WhatsApp.';
const TOO_OLD = 'Not sent: it waited more than a day (WhatsApp was paused or not linked).';

export function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// One queue step at a time: the caller sleeps for the returned milliseconds, then calls step() again.
// transport = the live WhatsApp connection: isConnected(), resolve(to) → jid or null, send(jid, text, typingMs) → message id.
// The sending rules (gap, quiet hours, typing, …) are read from the database on every step.
//
// One message at a time, across every running copy: a message goes out only while this copy holds the
// sending slot on whatsapp_state. The slot is taken in the same write that checks the gap and the pause,
// so two copies (Render runs two during a deploy) can never both start; it is renewed while the message is
// out and lapses SLOT_MS after its holder stops renewing (a copy that died), never while a send is running.
export function createSender({
  Queue, State, transport, config, now = () => new Date(), random = Math.random,
  owner = `${os.hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`, renewEveryMs = 20_000,
}) {
  const POLL_MS = 3_000;
  const slotFree = time => ({ $or: [{ sendingUntil: null }, { sendingUntil: { $lt: time } }] });
  const gapOver = time => ({ $or: [{ nextSendAt: null }, { nextSendAt: { $lte: time } }] });
  const holdUntil = time => new Date(time.getTime() + SLOT_MS);

  const ensureState = () => State.findOneAndUpdate({ _id: STATE_ID }, { $setOnInsert: { _id: STATE_ID } },
    { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  const takeSlot = (time, extra = {}) => State.findOneAndUpdate({ _id: STATE_ID, $and: [slotFree(time), extra] },
    { $set: { sendingBy: owner, sendingUntil: holdUntil(time) } }, { new: true }).lean();
  const releaseSlot = (fields = {}) => State.updateOne({ _id: STATE_ID, sendingBy: owner },
    { $set: { ...fields, sendingUntil: null }, $unset: { sendingBy: 1 } });

  // While this copy holds the slot nobody else is sending, so a row still 'sending' was cut off by a
  // stop. It may or may not have arrived: marked failed, never sent again on its own.
  const failInterrupted = time => Queue.updateMany({ status: 'sending' },
    { $set: { status: 'failed', lastError: INTERRUPTED, expiresAt: finishedExpiry(time) } });

  async function recoverInterrupted() {
    const time = now();
    await ensureState();
    if (!await takeSlot(time)) return 0; // another copy is sending right now; its own step settles its row
    try { return (await failInterrupted(time)).modifiedCount; }
    finally { await releaseSlot(); }
  }

  async function step() {
    const time = now();
    const state = await ensureState();
    const rules = effectiveSettings(state.settings);
    // Expire first, even while paused or offline, so the admin page never shows stale messages as waiting.
    await Queue.updateMany({ status: 'pending', createdAt: { $lt: new Date(time.getTime() - rules.maxAgeHours * 3_600_000) } },
      { $set: { status: 'expired', lastError: TOO_OLD, expiresAt: finishedExpiry(time) } });
    if (state.paused || !transport.isConnected()) return { waitMs: POLL_MS, reason: state.paused ? 'paused' : 'offline' };
    if (inQuietHours(rules, time, config.timeZone)) return { waitMs: 60_000, reason: 'quiet-hours' };
    const gapLeft = state.nextSendAt ? state.nextSendAt.getTime() - time.getTime() : 0;
    if (gapLeft > 0) return { waitMs: Math.min(gapLeft, POLL_MS), reason: 'gap' };
    if (!await Queue.exists({ status: 'pending', nextAttemptAt: { $lte: time } })) return { waitMs: POLL_MS, reason: 'empty' };

    // The real check: slot free, gap over and not paused, all in one write.
    const slot = await takeSlot(time, { paused: { $ne: true }, ...gapOver(time) });
    if (!slot) return { waitMs: POLL_MS, reason: 'busy' };
    await failInterrupted(time);
    const item = await Queue.findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: time } },
      { $set: { status: 'sending', sendPhase: 'preparing', attemptMessageId: generateMessageIDV2() }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true }).lean();
    if (!item) { await releaseSlot(); return { waitMs: POLL_MS, reason: 'empty' }; }
    // Book the shortest gap now, so even a lost final write cannot let the next message go sooner.
    await State.updateOne({ _id: STATE_ID, sendingBy: owner }, { $set: { nextSendAt: new Date(time.getTime() + rules.minGapSec * 1000) } });

    const renew = setInterval(() => {
      State.updateOne({ _id: STATE_ID, sendingBy: owner }, { $set: { sendingUntil: holdUntil(now()) } }).catch(() => {});
    }, renewEveryMs);
    renew.unref?.();
    let outcome;
    let attempted = false;
    let handedOff = false;
    try {
      const source = await whatsappQueue.queueSource(item);
      await OutgoingAttempt.create({ _id: item.attemptMessageId, queueId: item._id, to: item.to, source,
        cycleDraftId: item.finalMessageExpiryId || (item.event === 'lead.finalMessage' ? item.emailDraftId : undefined), phase: 'preparing' });
      await Queue.updateOne({ _id: item._id, status: 'sending', attemptMessageId: item.attemptMessageId }, { $set: { source } });
      if ((item.alt && !contacts.altSendingEnabled()) || !await expiry.canSend(item)) {
        await Queue.updateOne({ _id: item._id, status: 'sending' }, { $set: { status: 'cancelled', lastError: expiry.CANCELLED, expiresAt: finishedExpiry(now()) } });
        await OutgoingAttempt.updateOne({ _id: item.attemptMessageId }, { $set: { phase: 'cancelled' } });
        await releaseSlot();
        return { waitMs: POLL_MS, reason: 'cancelled', itemId: item._id };
      }
      const jid = await transport.resolve(item.to);
      if (!jid) {
        outcome = { status: 'failed', lastError: NOT_ON_WHATSAPP };
      } else {
        attempted = true;
        const messageId = await transport.send(jid, item.text, typingTime(rules, item.text.length, random()), {
          messageId: item.attemptMessageId,
          ...(item.media?.url ? { media: item.media } : {}),
          ...(item.finalMessageExpiryId ? { quoted: { key: { remoteJid: item.quotedMessage.chat, id: item.quotedMessage.id, fromMe: true }, message: { conversation: item.quotedMessage.text } } } : {}),
          beforeSend: async () => {
            if ((item.alt && !contacts.altSendingEnabled()) || !await expiry.canSend(item) || !await broadcastEligible(item) || !await stopFinalMessage.claimHandoff(item)) return false;
            handedOff = true;
            await OutgoingAttempt.updateOne({ _id: item.attemptMessageId }, { $set: { phase: 'handoff', handedOffAt: now() } });
            return true;
          },
        });
        outcome = { status: 'sent', messageId, messageChat: jid, sentAt: now(), lastError: null };
      }
    } catch (error) {
      const message = error?.message || 'Unknown sending error';
      outcome = error?.code === 'FINAL_MESSAGE_CHANGED'
        ? { status: 'cancelled', lastError: item.broadcastRecipientId ? 'Broadcast eligibility changed before sending.' : expiry.CANCELLED }
        : handedOff || item.attempts >= rules.maxAttempts
        ? { status: 'failed', lastError: message }
        : { status: 'pending', lastError: message, nextAttemptAt: new Date(now().getTime() + rules.retryDelayMin * 60_000) };
    } finally {
      clearInterval(renew);
    }
    const done = now();
    if (outcome.status !== 'pending') outcome.expiresAt = finishedExpiry(done);
    await Queue.updateOne({ _id: item._id, status: 'sending', attemptMessageId: item.attemptMessageId }, { $set: outcome });
    await OutgoingAttempt.updateOne({ _id: item.attemptMessageId }, { $set: { phase: outcome.status === 'pending' ? 'failed' : outcome.status, ...(outcome.messageId ? { resultMessageId: outcome.messageId } : {}) } });
    if (outcome.status === 'sent' && outcome.messageId) {
      await (await import('../../helpers/stopFinalMessage.js')).default.noteOutgoing(item.to, outcome.messageId, outcome.sentAt)
        .catch(error => console.error('[final message] could not record our outgoing message:', error.message));
    }

    // Every step that talked to WhatsApp waits the full gap, even a failed one: it may still have arrived.
    // The gap is written in the same write that frees the slot, so no copy can start in between.
    const nextSendAt = new Date(done.getTime() + rules.minGapSec * 1000 + Math.floor(random() * (rules.jitterSec * 1000 + 1)));
    const today = dayKey(time, config.timeZone);
    const sentToday = (slot.day === today ? slot.sentToday : 0) + (attempted ? 1 : 0);
    const { modifiedCount } = await releaseSlot({
      day: today, sentToday, nextSendAt,
      ...(outcome.status === 'sent' ? { lastSentAt: outcome.sentAt } : {}),
    });
    if (!modifiedCount) await State.updateOne({ _id: STATE_ID }, { $max: { nextSendAt } }); // the slot lapsed meanwhile; keep the gap anyway
    return { waitMs: POLL_MS, reason: outcome.status, itemId: item._id };
  }

  return { step, recoverInterrupted, owner };
}
