const { EmailHistory, EmailDraft } = require('../models/emailControlModel');
const { indiaDayKey, indiaDayStart } = require('./dateTime');

// Repair the small audit row from the accepted draft if its last write failed.
// The draft remains temporary; normal sends persist the permanent row immediately.
async function reconcileSent(ownership) {
  // An accepted audit row can also repair a failed temporary-draft update.
  const inFlight = await EmailDraft.find({ ...ownership, status: { $in: ['sending', 'failed'] } }).select('_id').lean();
  if (inFlight.length) {
    const accepted = await EmailHistory.find({ ...ownership, draftId: { $in: inFlight.map(d => d._id) }, status: 'sent' }).select('draftId providerId sentAt attempts').lean();
    if (accepted.length) await EmailDraft.bulkWrite(accepted.map(row => ({ updateOne: {
      filter: { _id: row.draftId, status: { $in: ['sending', 'failed'] } },
      update: { $set: { status: 'sent', providerId: row.providerId, sentAt: row.sentAt, attempts: row.attempts, failure: '' } },
    } })));
  }
  const drafts = await EmailDraft.find({ ...ownership, status: 'sent' }).select('event actor application to subject providerId sentAt expiresAt attemptCount lastAttemptAt attempts source sender templateName').lean();
  if (!drafts.length) return;
  const complete = await EmailHistory.find({ draftId: { $in: drafts.map(d => d._id) }, status: 'sent' }).select('draftId').lean();
  const recorded = new Set(complete.map(row => String(row.draftId)));
  const missing = drafts.filter(draft => !recorded.has(String(draft._id)));
  if (!missing.length) return;
  await EmailHistory.bulkWrite(missing.map(({ _id, ...draft }) => ({ updateOne: {
    filter: { draftId: _id },
    update: { $set: { ...draft, status: 'sent' }, $setOnInsert: { draftId: _id } }, upsert: true,
  } })));
}
async function queryOutbox(ownership, input = {}, now = new Date()) {
  await reconcileSent(ownership);
  const status = input.status || 'all';
  if (!['all', 'sent', 'failed', 'sending'].includes(status)) throw new Error('Invalid Outbox status');
  const page = Number(input.page || 1), pageSize = 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new Error('Invalid Outbox page');
  const search = String(input.q || '').trim();
  if (search.length > 200) throw new Error('Search must be at most 200 characters');
  const start = input.from ? indiaDayStart(input.from) : null;
  const end = input.to ? new Date(indiaDayStart(input.to).getTime() + 86400000) : null;
  if (start && end && start >= end) throw new Error('Start date must not follow end date');
  const base = { ...ownership, status: { $in: ['sent', 'failed', 'sending'] } };
  const filter = { ...base, ...(status === 'all' ? {} : { status }) };
  if (search) {
    const literal = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ subject: { $regex: literal, $options: 'i' } }, { to: { $regex: literal, $options: 'i' } }];
  }
  const eventTime = { $cond: [{ $eq: ['$status', 'sent'] }, '$sentAt', '$lastAttemptAt'] };
  const today = indiaDayStart(indiaDayKey(now));
  const [result, summaryRows] = await Promise.all([
    EmailHistory.aggregate([
      { $match: filter }, { $addFields: { eventTime } },
      ...(start || end ? [{ $match: { eventTime: { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) } } }] : []),
      { $sort: { eventTime: -1, _id: -1 } },
      { $facet: { rows: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }], total: [{ $count: 'value' }] } },
    ]),
    EmailHistory.aggregate([{ $match: base }, { $group: {
      _id: null,
      sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
      todaySent: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'sent'] }, { $gte: ['$sentAt', today] }, { $lte: ['$sentAt', now] }] }, 1, 0] } },
      sentRecipients: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, { $size: { $ifNull: ['$to', []] } }, 0] } },
      failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
      sending: { $sum: { $cond: [{ $eq: ['$status', 'sending'] }, 1, 0] } },
    } }]),
  ]);
  const total = result[0]?.total[0]?.value || 0;
  return { rows: result[0]?.rows || [], total, page, pageSize, pages: Math.ceil(total / pageSize),
    summary: { sent: 0, todaySent: 0, sentRecipients: 0, failed: 0, sending: 0, ...summaryRows[0], _id: undefined },
    serverNow: now.getTime() };
}
module.exports = { queryOutbox, reconcileSent };
