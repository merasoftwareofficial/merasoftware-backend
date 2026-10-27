import { inQuietHours, quietEnd, typingTime } from './settings.js';

// The sender checks the queue every 3 seconds, so a free turn is taken 1.5 seconds late on average.
const POLL_AVG_MS = 1_500;
// Looking the number up and handing the message to WhatsApp; about a second live (27 Oct 2026).
const SEND_MS = 1_000;
const byAge = (a, b) => a.createdAt - b.createdAt;

/**
 * When each waiting message should leave, worked out the way sender.js sends: one at a time, the oldest
 * of those whose retry time has come, "typing…" then the gap, nothing in quiet hours, and a message older
 * than maxAgeHours expires instead of going. An estimate: the gap's random part is taken at its average.
 *
 * rows: the pending and sending rows. Returns them in sending order, each with `eta` (a Date; null while
 * `stopped`, i.e. paused, offline or turned off) and `willExpire` (it would wait too long and be dropped).
 */
export function estimateQueue({ rows, nextSendAt, rules, now, timeZone, stopped = false }) {
  const maxAgeMs = rules.maxAgeHours * 3_600_000;
  const gapMs = rules.minGapSec * 1000 + rules.jitterSec * 500;
  const sending = rows.filter(row => row.status === 'sending');
  const waiting = rows.filter(row => row.status === 'pending').sort(byAge);
  const result = sending.map(row => ({ ...row, eta: now, willExpire: false }));
  if (stopped) return [...result, ...waiting.map(row => ({ ...row, eta: null, willExpire: false }))];

  let time = Math.max(now.getTime(), nextSendAt ? new Date(nextSendAt).getTime() : 0);
  if (sending.length) time = Math.max(time, now.getTime() + SEND_MS + gapMs); // the one going out now, then its gap
  while (waiting.length) {
    const ready = waiting.filter(row => new Date(row.nextAttemptAt).getTime() <= time);
    if (!ready.length) { time = Math.min(...waiting.map(row => new Date(row.nextAttemptAt).getTime())); continue; }
    if (inQuietHours(rules, new Date(time), timeZone)) { time = quietEnd(rules, new Date(time), timeZone).getTime(); continue; }
    const next = ready[0]; // oldest first, as the sender picks
    waiting.splice(waiting.indexOf(next), 1);
    const start = time + POLL_AVG_MS;
    if (start - new Date(next.createdAt).getTime() > maxAgeMs) { result.push({ ...next, eta: null, willExpire: true }); continue; }
    const arrives = start + typingTime(rules, next.text.length, 0.5) + SEND_MS;
    result.push({ ...next, eta: new Date(arrives), willExpire: false });
    time = arrives + gapMs;
  }
  return result;
}
