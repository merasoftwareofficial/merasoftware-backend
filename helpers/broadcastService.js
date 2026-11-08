const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Template = require('../models/messageTemplateModel');
const { Broadcast, BroadcastRecipient } = require('../models/broadcastModel');
const { audience, groupQuery } = require('./broadcastAudience');
const { content, encode, title, fail, composition, readComposition, compositionUsesName, compositionTitle } = require('./broadcastContent');
const deterministicId = text => new mongoose.Types.ObjectId(crypto.createHash('sha256').update(text).digest('hex').slice(0, 24));
const objectId = value => { if (!mongoose.isValidObjectId(value)) fail('Invalid record.'); return value; };
async function templateInput(input) {
  const extended = input.version === 2;
  const value = extended ? composition(input) : null;
  const doc = extended ? value.doc : content(input.doc);
  const name = input.name === undefined ? (extended ? compositionTitle(value) : title(doc)) : String(input.name).trim();
  if (!name || name.length > 100) fail('Use a message label of 1–100 characters.');
  return { name, message: extended ? JSON.stringify(value) : encode(doc) };
}
async function listTemplates() {
  const rows = await Template.find({ purpose: 'broadcast' }).sort({ lastUsedAt: -1, updatedAt: -1, _id: -1 }).lean();
  return rows.map(({ message, ...row }) => ({ ...row, ...readComposition(message) }));
}
async function saveTemplate(input, userId, id) {
  const save = session => saveTemplateContent(input, userId, id, session);
  return input.media ? require('./broadcastMedia').withMediaLock(input.media.id, save) : save();
}
async function saveTemplateContent(input, userId, id, session) {
  const values = await templateInput(input);
  if (!id) {
    const data = { ...values, purpose: 'broadcast', createdBy: userId };
    return session ? (await Template.create([data], { session }))[0] : Template.create(data);
  }
  const row = await Template.findOneAndUpdate({ _id: objectId(id), purpose: 'broadcast' }, { $set: values }, { new: true, session });
  if (!row) throw Object.assign(new Error('Saved message not found.'), { status: 404 });
  return row;
}
async function deleteTemplate(id) {
  const row = await Template.findOneAndDelete({ _id: objectId(id), purpose: 'broadcast' });
  if (!row) throw Object.assign(new Error('Saved message not found.'), { status: 404 });
}
async function submit(input, userId) {
  const accept = session => acceptBroadcast(input, userId, session);
  return input.media ? require('./broadcastMedia').withMediaLock(input.media.id, accept) : accept();
}
async function acceptBroadcast(input, userId, session) {
  groupQuery(input.audience);
  if (typeof input.requestKey !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(input.requestKey)) fail('A valid send request key is required.');
  if (!['new', 'template'].includes(input.origin)) fail('Choose a new or saved message.');
  const channel = input.channel || 'whatsapp';
  require('./reviewDelivery').channelsFor(channel);
  const message = input.version === 2 ? JSON.stringify(composition(input)) : encode(input.doc);
  if (channel !== 'whatsapp' && !readComposition(message).subject) fail('Write an email subject.');
  const templateId = input.origin === 'template' ? objectId(input.templateId) : undefined;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([input.audience, message, input.origin, templateId, channel])).digest('hex');
  const id = deterministicId(`${userId}:${input.requestKey}`);
  let row = await Broadcast.findById(id).session(session || null);
  if (!row) {
    if (templateId && !await Template.exists({ _id: templateId, purpose: 'broadcast' }).session(session || null)) fail('Saved message no longer exists.');
    const requireName = compositionUsesName(readComposition(message));
    if (!(await audience(input.audience, { requireName, channel })).count) fail(requireName ? 'No one in this group has both a usable number and a name. Remove the name from the message, or choose another group.' : 'This group has no eligible phone numbers.');
    try {
      const data = { _id: id, createdBy: userId, requestKey: input.requestKey, fingerprint, audience: input.audience, message, channel, templateId, origin: input.origin };
      row = session ? (await Broadcast.create([data], { session }))[0] : await Broadcast.create(data);
    } catch (error) { if (session || error.code !== 11000) throw error; row = await Broadcast.findById(id); }
  }
  const legacyFingerprint = crypto.createHash('sha256').update(JSON.stringify([input.audience, message, input.origin, templateId])).digest('hex');
  if (row.fingerprint !== fingerprint && !(!row.channel && row.fingerprint === legacyFingerprint)) throw Object.assign(new Error('This send request was already used for a different message.'), { status: 409 });
  await completeAcceptance(row, session);
  return { id: row._id, state: row.state, accepted: true };
}
async function completeAcceptance(row, session) {
  if (row.acceptanceCompletedAt) return;
  // Retry-safe side effects: one template per new broadcast, and never an implicit template edit.
  if (row.origin === 'new') {
    const autoId = deterministicId(`broadcast-template:${row._id}`);
    await Template.updateOne({ _id: autoId }, { $setOnInsert: { purpose: 'broadcast', name: compositionTitle(readComposition(row.message)), message: row.message, createdBy: row.createdBy, sourceBroadcastId: row._id }, $max: { lastUsedAt: row.createdAt } }, { upsert: true, session });
  } else {
    await Template.updateOne({ _id: row.templateId, purpose: 'broadcast' }, { $max: { lastUsedAt: row.createdAt } }, { session });
  }
  // Acceptance is replayable: an older recovery must never replace a newer preference.
  await require('../models/emailControlModel').EmailPolicy.updateOne({ event: 'broadcast.manual', $or: [{ updatedAt: { $lte: row.createdAt } }, { updatedAt: { $exists: false } }] }, { $set: { channel: row.channel || 'whatsapp', updatedAt: row.createdAt } }, { timestamps: false, session });
  await require('../models/emailControlModel').EmailPolicy.updateOne({ event: 'broadcast.manual' }, { $setOnInsert: { channel: row.channel || 'whatsapp', updatedAt: row.createdAt } }, { upsert: true, timestamps: false, session });
  await Broadcast.updateOne({ _id: row._id }, { $set: { acceptanceCompletedAt: new Date() } }, { session });
}
async function history() {
  const rows = await Broadcast.find().sort({ createdAt: -1 }).limit(30).lean();
  const counts = await BroadcastRecipient.aggregate([{ $match: { broadcastId: { $in: rows.map(row => row._id) } } }, { $group: { _id: { id: '$broadcastId', state: '$state' }, count: { $sum: 1 } } }]);
  return rows.map(row => ({ id: row._id, audience: row.audience, channel: row.channel || 'whatsapp', title: compositionTitle(readComposition(row.message)), state: row.state, total: row.total, excluded: row.excluded || {}, createdAt: row.createdAt,
    counts: Object.fromEntries(counts.filter(count => String(count._id.id) === String(row._id)).map(count => [count._id.state, count.count])) }));
}
async function recipients(id, pageInput) {
  objectId(id);
  const page = Math.max(1, Math.min(100000, Number.parseInt(pageInput, 10) || 1));
  const filter = { broadcastId: id };
  const [rows, total] = await Promise.all([
    BroadcastRecipient.find(filter).sort({ _id: 1 }).skip((page - 1) * 50).limit(50).select('phone email channel part parts state reason sentAt').lean(),
    BroadcastRecipient.countDocuments(filter),
  ]);
  return { rows, total, page, pages: Math.ceil(total / 50) };
}
async function retryEmail(id) {
  objectId(id);
  const broadcast = await Broadcast.findById(id);
  if (!broadcast) throw Object.assign(new Error('Broadcast not found.'), { status: 404 });
  const { EmailDraft, EmailHistory } = require('../models/emailControlModel');
  let count = 0;
  for (const recipient of await BroadcastRecipient.find({ broadcastId: id, channel: 'email', state: 'failed' }).lean()) {
    const draft = await EmailDraft.findById(recipient._id).lean();
    const accepted = await EmailHistory.exists({ draftId: recipient._id, status: 'sent', providerId: { $nin: [null, ''] } });
    if (accepted || draft?.status === 'sent') {
      await BroadcastRecipient.updateOne({ _id: recipient._id, state: 'failed' }, { $set: { state: 'sent', sentAt: draft?.sentAt, reason: '' } });
    } else if (draft?.status === 'failed' && draft.expiresAt > new Date() && Date.now() - draft.createdAt.getTime() < 23 * 3600000) {
      // Reuse the same provider key while its 24-hour dedupe window is still valid.
      count += (await BroadcastRecipient.updateOne({ _id: recipient._id, state: 'failed' }, { $set: { state: 'waiting', reason: '' } })).modifiedCount;
    }
  }
  if (count) await Broadcast.updateOne({ _id: id }, { $set: { state: 'ready' }, $unset: { finishedAt: 1 } });
  return { count, message: count ? `${count} failed email deliveries will retry through the existing email service.` : 'No safe email retries are available. Interrupted or older deliveries need review to avoid duplicates.' };
}
module.exports = { retryEmail, submit, history, recipients, listTemplates, saveTemplate, deleteTemplate, deterministicId, completeAcceptance };
