// Website Media Library attests immutable asset metadata; login tokens cannot attest media.
const { createHmac } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { sessionSecret } = require('./sessionToken');
const key = () => createHmac('sha256', sessionSecret()).update('broadcast-media-v1').digest('hex');
function validateMedia(value) {
  if (!value || typeof value !== 'object') throw new Error('Choose a library image or video.');
  const { id, url, kind, bytes, format, publicId, assetId } = value;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com' || parsed.username || parsed.password || !/^[a-f\d]{24}$/i.test(id) || !publicId || !assetId) throw new Error('Invalid library media.');
  // Conservative outbound limits, independent of the website's larger upload limits.
  if (!['image', 'video'].includes(kind) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > (kind === 'video' ? 16 : 5) * 1024 * 1024 || !(kind === 'video' ? ['mp4'] : ['jpg', 'jpeg', 'png']).includes(format)) throw new Error('Broadcast supports JPG/PNG up to 5 MB or MP4 up to 16 MB.');
  return { id, url, kind, bytes, format, publicId, assetId };
}
function verifyMedia(token) {
  return validateMedia(jwt.verify(token, key(), { algorithms: ['HS256'], audience: 'broadcast-media', issuer: 'merasoftware-website', maxAge: '60s' }).asset);
}
async function withMediaLock(id, work) {
  if (!/^[a-f\d]{24}$/i.test(id)) throw new Error('Invalid media identity.');
  const mongoose = require('mongoose');
  const { Lock } = require('../whatsapp/src/models.js');
  const lockId = `broadcast-media:${id}`;
  // Keep one guard document, so save/send and retirement always write the same
  // record in their transactions. No expiring lease can permit a stale save.
  try {
    await Lock.updateOne({ _id: lockId }, { $setOnInsert: { owner: 'available', revision: 0, expiresAt: new Date('2100-01-01') } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const guard = await Lock.findOneAndUpdate({ _id: lockId, owner: { $ne: 'retired' }, $or: [{ owner: 'available' }, { expiresAt: { $lte: new Date() } }] },
        { $inc: { revision: 1 }, $set: { owner: 'available', expiresAt: new Date('2100-01-01') } }, { session, new: true });
      if (!guard) throw new Error('Media is being used or removed. Try again.');
      return work(session, () => Lock.updateOne({ _id: lockId }, { $set: { owner: 'retired' } }, { session }));
    });
  } finally { await session.endSession(); }
}
async function retireMedia(id) {
  const { Lock } = require('../whatsapp/src/models.js');
  if (await Lock.exists({ _id: `broadcast-media:${id}`, owner: 'retired' })) return { retired: true };
  return withMediaLock(id, async (session, retire) => {
    const { Broadcast } = require('../models/broadcastModel');
    const Template = require('../models/messageTemplateModel');
    // Match canonical JSON asset identity. Historical sends also retain reviewable media.
    const needle = `"id":"${id}"`;
    if (await Broadcast.exists({ message: { $regex: needle } }).session(session) || await Template.exists({ purpose: 'broadcast', message: { $regex: needle } }).session(session)) throw new Error('This media is used by a Broadcast or saved message.');
    await retire();
    return { retired: true };
  });
}
module.exports = { key, validateMedia, verifyMedia, withMediaLock, retireMedia };
