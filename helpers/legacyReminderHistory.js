const mongoose = require('mongoose');
const { EmailHistory } = require('../models/emailControlModel');
const { Queue } = require('../whatsapp/src/models.js');
const User = require('../models/userModel');
const { byKey } = require('./emailCatalog');
const sources = {
  reservation: { model: () => require('../models/offerReservationModel'), prefixes: ['offer-reserved', 'offer-reservation-extended', 'offer-reservation-reminder', 'offer-reservation-expired', 'offer-start-request', 'offer-start-received', 'offer-start-pending'], events: ['offer.reserved', 'offer.reservation.extended', 'offer.reservation.dayPassed', 'offer.reservation.reminder', 'offer.reservation.sixHours', 'offer.reservation.lastHour', 'offer.reservation.expired', 'offer.start.request.admin', 'offer.start.request.received'] },
  package_request: { model: () => require('../models/packageStartRequestModel'), prefixes: ['package-start-request', 'package-start-received', 'package-start-pending'], events: ['package.start.request.admin', 'package.start.request.received'] },
  offer_payment: { model: () => require('../models/invoiceModel'), prefixes: ['offer-reminder'], events: ['offer.payment.reminder'] },
};
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const entityOf = key => /:([a-f\d]{24})(?::|$)/i.exec(key || '')?.[1]?.toLowerCase() || null;
const sourceOf = key => Object.keys(sources).find(source => sources[source].prefixes.some(prefix => String(key).startsWith(`${prefix}:`)));
async function legacyReminderHistory({ source = 'all', entityId, page = 1, pageSize = 20 } = {}) {
  if (typeof source !== 'string' || (source !== 'all' && !Object.hasOwn(sources, source))) fail('Unknown history source.');
  if (entityId && (source === 'all' || !mongoose.isValidObjectId(entityId))) fail('Choose a history source and valid record.');
  if (entityId && !await sources[source].model().exists({ _id: entityId })) fail('This record is no longer available.', 404);
  page = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
  pageSize = Math.max(1, Math.min(50, Number.parseInt(pageSize, 10) || 20));
  const families = source === 'all' ? Object.keys(sources) : [source];
  const query = { application: 'portal', $or: families.flatMap(family => sources[family].prefixes.map(prefix => ({ event: { $in: sources[family].events }, dedupeKey: { $regex: `^${prefix}:${entityId ? String(entityId).toLowerCase() : '[a-fA-F0-9]{24}'}(:|$)` } }))) };
  const [histories, total] = await Promise.all([
    EmailHistory.find(query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).select('dedupeKey draftId event subject status delivery providerId sentAt createdAt updatedAt').lean(),
    EmailHistory.countDocuments(query),
  ]);
  const queue = histories.length ? await Queue.find({ emailDraftId: { $in: histories.map(row => row.draftId) } }).select('emailDraftId status sentAt lastError').lean() : [];
  const entities = new Map();
  await Promise.all(families.map(async family => {
    const ids = histories.filter(row => sourceOf(row.dedupeKey) === family).map(row => entityOf(row.dedupeKey)).filter(Boolean);
    if (!ids.length) return;
    const records = await sources[family].model().find({ _id: { $in: ids } }).select('userId offerSnapshot.title packageSnapshot.name invoiceNumber').lean();
    records.forEach(row => entities.set(`${family}:${row._id}`, row));
  }));
  const users = await User.find({ _id: { $in: [...entities.values()].map(row => row.userId).filter(Boolean) } }).select('name').lean();
  const usersById = new Map(users.map(user => [String(user._id), user.name]));
  return { source, entityId: entityId || null, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), rows: histories.map(history => {
    const family = sourceOf(history.dedupeKey), id = entityOf(history.dedupeKey), entity = entities.get(`${family}:${id}`);
    const copies = queue.filter(row => String(row.emailDraftId) === String(history.draftId));
    return { id: String(history._id), source: family, entityId: id, event: history.event, actionLabel: byKey.get(history.event)?.label || 'Message',
      subject: history.subject || '', customer: entity ? usersById.get(String(entity.userId)) || 'Customer' : 'Record no longer available',
      context: entity?.offerSnapshot?.title || entity?.packageSnapshot?.name || entity?.invoiceNumber || '',
      milestone: family === 'offer_payment' ? `Day ${history.dedupeKey.split(':').at(-1)}` : history.dedupeKey.startsWith('package-start-pending:') ? `Team reminder ${history.dedupeKey.split(':').at(-1)}/3` : history.dedupeKey.startsWith('offer-start-pending:') ? `Team reminder ${history.dedupeKey.split(':').at(-1)}/3` : '',
      status: history.status || 'unknown', at: history.sentAt || history.updatedAt || history.createdAt,
      emailStatus: history.delivery?.emailStatus || (history.providerId ? 'sent' : 'not-recorded'),
      whatsapp: copies.map(row => ({ status: row.status, sentAt: row.sentAt || null })),
      whatsappLastKnown: history.delivery?.whatsappStatus || null };
  }) };
}
module.exports = { legacyReminderHistory };
