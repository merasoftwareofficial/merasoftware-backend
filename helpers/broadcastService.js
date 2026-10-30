const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Template = require('../models/messageTemplateModel');
const { Broadcast, BroadcastRecipient } = require('../models/broadcastModel');
const { audience, groupQuery } = require('./broadcastAudience');
const { content, encode, decode, title, usesName, fail } = require('./broadcastContent');
const deterministicId = text => new mongoose.Types.ObjectId(crypto.createHash('sha256').update(text).digest('hex').slice(0, 24));
const objectId = value => { if (!mongoose.isValidObjectId(value)) fail('Invalid record.'); return value; };
async function templateInput(input) {
  const doc = content(input.doc);
  const name = input.name === undefined ? title(doc) : String(input.name).trim();
  if (!name || name.length > 100) fail('Use a message label of 1–100 characters.');
  return { name, message: encode(doc) };
}
async function listTemplates() {
  const rows = await Template.find({ purpose: 'broadcast' }).sort({ lastUsedAt: -1, updatedAt: -1, _id: -1 }).lean();
  return rows.map(({ message, ...row }) => ({ ...row, doc: decode(message) }));
}
async function saveTemplate(input, userId, id) {
  const values = await templateInput(input);
  if (!id) return Template.create({ ...values, purpose: 'broadcast', createdBy: userId });
  const row = await Template.findOneAndUpdate({ _id: objectId(id), purpose: 'broadcast' }, { $set: values }, { new: true });
  if (!row) throw Object.assign(new Error('Saved message not found.'), { status: 404 });
  return row;
}
async function deleteTemplate(id) {
  const row = await Template.findOneAndDelete({ _id: objectId(id), purpose: 'broadcast' });
  if (!row) throw Object.assign(new Error('Saved message not found.'), { status: 404 });
}
async function submit(input, userId) {
  groupQuery(input.audience);
  if (typeof input.requestKey !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(input.requestKey)) fail('A valid send request key is required.');
  if (!['new', 'template'].includes(input.origin)) fail('Choose a new or saved message.');
  const message = encode(input.doc);
  const templateId = input.origin === 'template' ? objectId(input.templateId) : undefined;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([input.audience, message, input.origin, templateId])).digest('hex');
  const id = deterministicId(`${userId}:${input.requestKey}`);
  let row = await Broadcast.findById(id);
  if (!row) {
    if (templateId && !await Template.exists({ _id: templateId, purpose: 'broadcast' })) fail('Saved message no longer exists.');
    const requireName = usesName(decode(message));
    if (!(await audience(input.audience, { requireName })).count) fail(requireName ? 'No one in this group has both a usable number and a name. Remove the name from the message, or choose another group.' : 'This group has no eligible phone numbers.');
    try {
      row = await Broadcast.create({ _id: id, createdBy: userId, requestKey: input.requestKey, fingerprint, audience: input.audience, message, templateId, origin: input.origin });
    } catch (error) { if (error.code !== 11000) throw error; row = await Broadcast.findById(id); }
  }
  if (row.fingerprint !== fingerprint) throw Object.assign(new Error('This send request was already used for a different message.'), { status: 409 });
  await completeAcceptance(row);
  return { id: row._id, state: row.state, accepted: true };
}
async function completeAcceptance(row) {
  if (row.acceptanceCompletedAt) return;
  // Retry-safe side effects: one template per new broadcast, and never an implicit template edit.
  if (row.origin === 'new') {
    const autoId = deterministicId(`broadcast-template:${row._id}`);
    await Template.updateOne({ _id: autoId }, { $setOnInsert: { purpose: 'broadcast', name: title(decode(row.message)), message: row.message, createdBy: row.createdBy, sourceBroadcastId: row._id }, $max: { lastUsedAt: row.createdAt } }, { upsert: true });
  } else {
    await Template.updateOne({ _id: row.templateId, purpose: 'broadcast' }, { $max: { lastUsedAt: row.createdAt } });
  }
  await Broadcast.updateOne({ _id: row._id }, { $set: { acceptanceCompletedAt: new Date() } });
}
async function history() {
  const rows = await Broadcast.find().sort({ createdAt: -1 }).limit(30).lean();
  const counts = await BroadcastRecipient.aggregate([{ $match: { broadcastId: { $in: rows.map(row => row._id) } } }, { $group: { _id: { id: '$broadcastId', state: '$state' }, count: { $sum: 1 } } }]);
  return rows.map(row => ({ id: row._id, audience: row.audience, title: title(decode(row.message)), state: row.state, total: row.total, createdAt: row.createdAt,
    counts: Object.fromEntries(counts.filter(count => String(count._id.id) === String(row._id)).map(count => [count._id.state, count.count])) }));
}
async function recipients(id, pageInput) {
  objectId(id);
  const page = Math.max(1, Math.min(100000, Number.parseInt(pageInput, 10) || 1));
  const filter = { broadcastId: id };
  const [rows, total] = await Promise.all([
    BroadcastRecipient.find(filter).sort({ _id: 1 }).skip((page - 1) * 50).limit(50).select('phone state reason sentAt').lean(),
    BroadcastRecipient.countDocuments(filter),
  ]);
  return { rows, total, page, pages: Math.ceil(total / 50) };
}
module.exports = { submit, history, recipients, listTemplates, saveTemplate, deleteTemplate, deterministicId, completeAcceptance };
