const { Queue } = require('../whatsapp/src/models.js');

// The final message can go to two numbers: the person's main number and the alternate number on their lead
// (merasoftware/src/docs/signup.md §3.9). One cycle, one countdown; each number has its own queue row.
// row.phone stays the main number: it is who the cycle is for. row.altPhone is the alternate chosen when it was
// prepared, and row.sends records every copy that went (number, message, chat), for replies, echoes and closure.

/** Every number of this cycle: the main, its alternate, and any number a copy already went to. */
const cycleNumbers = row => [...new Set([row?.phone, row?.altPhone, ...(row?.sends || []).map(send => send.phone)].filter(Boolean))];

/** A query part matching cycles on this number, whichever of its numbers it is. */
const onNumber = phone => ({ $or: [{ phone }, { altPhone: phone }, { 'sends.phone': phone }] });

/** The queue rows of a cycle's first message (one per number), sent ones first in sending order. */
async function originalCopies(draftId, { session } = {}) {
  if (!draftId) return [];
  const rows = await Queue.find({ emailDraftId: draftId }).select('status sendPhase to alt sentAt messageId messageChat text').session(session || null).lean();
  return rows.sort((a, b) => (a.sentAt ? a.sentAt.getTime() : Infinity) - (b.sentAt ? b.sentAt.getTime() : Infinity));
}

/**
 * Where the first message stands across its copies: 'waiting' once any copy went (the countdown starts at the
 * first), 'queued' while one is still on its way, 'not-sent' when every copy failed or was cancelled, null with none.
 */
function copiesState(rows) {
  const sent = rows.filter(row => row.status === 'sent');
  if (sent.length) return { status: 'waiting', first: sent[0], sent };
  if (rows.some(row => ['pending', 'sending'].includes(row.status))) return { status: 'queued', sent };
  return rows.length ? { status: 'not-sent', sent } : null;
}

/** The send record of one queue row. */
const sendOf = row => ({ phone: row.to, id: row.messageId, chat: row.messageChat || `${row.to}@s.whatsapp.net`, text: row.text, sentAt: row.sentAt });

/**
 * May this copy of the first message still go, now that the countdown is running? Only to a number of this cycle
 * that has not had it, while no reply came and no message of ours is waiting to be classified.
 */
function laterCopyMayGo(row, item) {
  if (row.status !== 'waiting' || !item?.to) return false;
  if (!cycleNumbers(row).includes(item.to) || (row.sends || []).some(send => send.phone === item.to)) return false;
  if (row.outboundChecks?.length) return false;
  return !(row.lastReplyAt && row.sentAt && row.lastReplyAt >= row.sentAt);
}

module.exports = { cycleNumbers, onNumber, originalCopies, copiesState, sendOf, laterCopyMayGo };
