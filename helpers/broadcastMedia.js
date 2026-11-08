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
  const { Lock } = require('../whatsapp/src/models.js');
  const owner = require('node:crypto').randomUUID(), lockId = `broadcast-media:${id}`;
  try {
    await Lock.updateOne({ _id: lockId, expiresAt: { $lte: new Date() } }, { $set: { owner, expiresAt: new Date(Date.now() + 120000) } }, { upsert: true });
  } catch (error) { if (error.code === 11000) throw new Error('Media is being used or removed. Try again.'); throw error; }
  try { return await work(async () => Lock.updateOne({ _id: lockId, owner }, { $set: { owner: 'retired', expiresAt: new Date('2100-01-01') } })); }
  finally { await Lock.deleteOne({ _id: lockId, owner }); }
}
async function retireMedia(id) {
  const { Lock } = require('../whatsapp/src/models.js');
  if (await Lock.exists({ _id: `broadcast-media:${id}`, owner: 'retired' })) return { retired: true };
  return withMediaLock(id, async retire => {
    const { Broadcast } = require('../models/broadcastModel');
    const Template = require('../models/messageTemplateModel');
    // Match canonical JSON asset identity. Historical sends also retain reviewable media.
    const needle = `"id":"${id}"`;
    if (await Broadcast.exists({ message: { $regex: needle } }) || await Template.exists({ purpose: 'broadcast', message: { $regex: needle } })) throw new Error('This media is used by a Broadcast or saved message.');
    await retire();
    return { retired: true };
  });
}
module.exports = { key, validateMedia, verifyMedia, withMediaLock, retireMedia };
