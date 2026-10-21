import { STATE_ID, finishedExpiry } from './models.js';
import { effectiveSettings, inQuietHours } from './settings.js';

const INTERRUPTED = 'The service restarted while sending this message, so it may or may not have arrived. Not sent again automatically, to avoid a duplicate.';
const NOT_ON_WHATSAPP = 'This number is not on WhatsApp.';
const TOO_OLD = 'Not sent: it waited more than a day (WhatsApp was paused or not linked).';

export function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// One queue step at a time: the caller sleeps for the returned milliseconds, then calls step() again.
// transport = the live WhatsApp connection: isConnected(), resolve(to) → jid or null, send(jid, text, typingMs) → message id.
// The sending rules (gap, daily limit, quiet hours, typing, …) are read from the database on every step.
export function createSender({ Queue, State, transport, config, now = () => new Date(), random = Math.random }) {
  const POLL_MS = 3_000;

  async function recoverInterrupted() {
    const time = now();
    const { modifiedCount } = await Queue.updateMany({ status: 'sending' },
      { $set: { status: 'failed', lastError: INTERRUPTED, expiresAt: finishedExpiry(time) } });
    return modifiedCount;
  }

  async function step() {
    const time = now();
    const state = await State.findOneAndUpdate({ _id: STATE_ID }, { $setOnInsert: { _id: STATE_ID } },
      { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    const rules = effectiveSettings(state.settings);
    // Expire first, even while paused or offline, so the admin page never shows stale messages as waiting.
    await Queue.updateMany({ status: 'pending', createdAt: { $lt: new Date(time.getTime() - rules.maxAgeHours * 3_600_000) } },
      { $set: { status: 'expired', lastError: TOO_OLD, expiresAt: finishedExpiry(time) } });
    if (state.paused || !transport.isConnected()) return { waitMs: POLL_MS, reason: state.paused ? 'paused' : 'offline' };
    if (inQuietHours(rules, time, config.timeZone)) return { waitMs: 60_000, reason: 'quiet-hours' };

    const today = dayKey(time, config.timeZone);
    const sentToday = state.day === today ? state.sentToday : 0;
    if (sentToday >= rules.dailyLimit) return { waitMs: 60_000, reason: 'daily-limit' };
    const gapLeft = state.nextSendAt ? state.nextSendAt.getTime() - time.getTime() : 0;
    if (gapLeft > 0) return { waitMs: Math.min(gapLeft, POLL_MS), reason: 'gap' };

    const item = await Queue.findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: time } },
      { $set: { status: 'sending' }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true }).lean();
    if (!item) return { waitMs: POLL_MS, reason: 'empty' };

    let outcome;
    let attempted = false;
    try {
      const jid = await transport.resolve(item.to);
      if (!jid) {
        outcome = { status: 'failed', lastError: NOT_ON_WHATSAPP };
      } else {
        attempted = true;
        // Typing time grows with the message: the shortest time + 1 second per 100 letters + up to 1 second at random.
        const typingMs = rules.typing ? Math.min(rules.typingMaxSec * 1000,
          rules.typingMinSec * 1000 + Math.floor(item.text.length / 100) * 1000 + Math.floor(random() * 1000)) : 0;
        const messageId = await transport.send(jid, item.text, typingMs);
        outcome = { status: 'sent', messageId, sentAt: now(), lastError: null };
      }
    } catch (error) {
      const message = error?.message || 'Unknown sending error';
      outcome = item.attempts >= rules.maxAttempts
        ? { status: 'failed', lastError: message }
        : { status: 'pending', lastError: message, nextAttemptAt: new Date(now().getTime() + rules.retryDelayMin * 60_000) };
    }
    const done = now();
    if (outcome.status !== 'pending') outcome.expiresAt = finishedExpiry(done);
    await Queue.updateOne({ _id: item._id, status: 'sending' }, { $set: outcome });

    // Every step that talked to WhatsApp waits the full gap, even a failed one: it may still have arrived.
    const nextSendAt = new Date(done.getTime() + rules.minGapSec * 1000 + Math.floor(random() * (rules.jitterSec * 1000 + 1)));
    await State.updateOne({ _id: STATE_ID }, { $set: {
      day: today,
      sentToday: sentToday + (attempted ? 1 : 0),
      nextSendAt,
      ...(outcome.status === 'sent' ? { lastSentAt: outcome.sentAt } : {}),
    } });
    return { waitMs: POLL_MS, reason: outcome.status, itemId: item._id };
  }

  return { step, recoverInterrupted };
}
