const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { Preview, Version, Receipt } = require('../models/websitePreviewModel');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const { getOrderState, isProjectOrder } = require('./orderStatusEngine');
const { POLICY, MIME, fail, manifestFor, previewHost } = require('./websitePreviewPolicy');
const { signCapability, verifyCapability } = require('./websitePreviewTokens');

async function access(projectId, userId, role, adminOnly = false, session = null) {
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(userId)) fail('Project not found', 404);
  const user = await User.findById(userId).select('roles isActive isGuest deletedAt').session(session).lean();
  if (!user || user.isActive === false || user.isGuest || user.deletedAt || !user.roles?.includes(role)) fail('Preview access denied', 403);
  const admin = role === 'admin';
  if (adminOnly && !admin) fail('Admin access required', 403);
  const order = await Order.findOne({ _id: projectId, ...(admin ? {} : { userId }) }).session(session).lean();
  if (!order || !isProjectOrder(order)) fail('Project not found', 404);
  const owner = await User.findById(order.userId).select('isGuest isActive deletedAt').session(session).lean();
  if (!owner || owner.isGuest || owner.deletedAt || owner.isActive === false) fail('Client account is unavailable', 403);
  const code = getOrderState(order).code;
  if (['cancelled', 'rejected'].includes(code) || (!admin && code === 'pending_approval')) fail('Project is unavailable for preview', 403);
  return { admin, order };
}
const tx = work => mongoose.connection.transaction(work);
async function state(projectId, userId, role) {
  const { admin } = await access(projectId, userId, role);
  const preview = await Preview.findById(projectId).lean();
  if (!admin && (!preview?.visible || !preview.currentVersion)) return { available: false };
  const current = preview?.currentVersion ? await Version.findById(preview.currentVersion).select('state readyAt manifestHash').lean() : null;
  const serviceUrl = process.env.WEBSITE_PREVIEW_SERVICE_URL || '';
  const configured = Boolean(serviceUrl && process.env.WEBSITE_PREVIEW_PRIVATE_KEY && process.env.WEBSITE_PREVIEW_PUBLIC_KEY && process.env.WEBSITE_PREVIEW_SERVICE_SECRET);
  return { policy: { ...POLICY, mime: MIME }, serviceUrl, configured, admin, available: Boolean(configured && current?.state === 'ready' && (admin || preview.visible)),
    host: admin ? preview?.host || '' : undefined, visible: Boolean(preview?.visible), currentVersion: current?._id || null,
    readyAt: current?.readyAt || null, revision: preview?.revision || 0 };
}
async function settings(projectId, userId, role, body) {
  await access(projectId, userId, role, true);
  let result;
  await tx(async session => {
    await access(projectId, userId, role, true, session);
    let p = await Preview.findById(projectId).session(session);
    if (!p) p = new Preview({ _id: projectId });
    if (body.host !== undefined) {
      const host = previewHost(body.host);
      if (p.host && p.host !== host) fail('A configured preview hostname cannot be reassigned here', 409);
      p.host = host;
    }
    if (body.visible !== undefined) {
      if (typeof body.visible !== 'boolean') fail('Visibility must be true or false');
      if (body.visible && !p.currentVersion) fail('Upload a ready website before enabling client access', 409);
      p.visible = body.visible;
    }
    p.revision++; await p.save({ session }); result = p.toObject();
  });
  return { host: result.host, visible: result.visible, revision: result.revision };
}
async function begin(projectId, userId, role, body) {
  await access(projectId, userId, role, true);
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId || '')) fail('A unique upload request ID is required');
  const preview = await Preview.findById(projectId).lean();
  if (!preview?.host) fail('Configure the project preview hostname first', 409);
  const old = await Version.findOne({ projectId, requestId: body.requestId });
  if (old) {
    const retry = manifestFor(body.files, projectId, old._id);
    if (old.adminId.toString() !== userId || retry.hash !== old.manifestHash) fail('Upload request ID was already used for different content', 409);
    return { versionId: old._id, state: old.state };
  }
  const versionId = randomUUID(), parsed = manifestFor(body.files, projectId, versionId);
  await Version.create({ _id: versionId, projectId, adminId: userId, requestId: body.requestId, manifest: parsed.manifest,
    manifestHash: parsed.hash, totalBytes: parsed.total, expectedVersion: preview.currentVersion,
    expiresAt: new Date(Date.now() + POLICY.uploadMs) });
  return { versionId, state: 'uploading' };
}
async function uploadBatch(projectId, versionId, userId, role) {
  await access(projectId, userId, role, true);
  const active = await Version.findOne({ _id: versionId, projectId, adminId: userId, state: 'uploading', expiresAt: { $gt: new Date() } }).select('expiresAt').lean();
  if (!active) fail('Upload expired, frozen or unavailable; start a new upload', 409);
  const until = new Date(Math.min(Date.now() + POLICY.tokenMs, active.expiresAt.getTime()));
  const v = await Version.findOneAndUpdate({ _id: versionId, projectId, adminId: userId, state: 'uploading', expiresAt: { $gt: new Date() } },
    { $max: { latestTokenExpiry: until } }, { new: true }).lean();
  if (!v) fail('Upload expired, frozen or unavailable; start a new upload', 409);
  const manifest = v.manifest.map(({ path, key, size, contentType }) => ({ path, key, size, contentType }));
  return { capability: signCapability({ kind: 'upload', projectId, versionId, adminId: userId, manifestHash: v.manifestHash,
    validUntil: until.getTime(), policy: POLICY }, 'website-preview-upload', 60), manifest };
}
async function grant(projectId, userId, role, nonce) {
  const { admin } = await access(projectId, userId, role);
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(nonce || '')) fail('Invalid preview nonce');
  const p = await Preview.findById(projectId).lean();
  if (!p?.host || !p.currentVersion || (!admin && !p.visible)) fail('Website preview is not available', 404);
  const v = await Version.findById(p.currentVersion).select('state manifestHash').lean();
  if (v?.state !== 'ready') fail('Website preview is not ready', 409);
  const permissionUntil = Math.floor(Date.now() / 1000) + POLICY.permissionSeconds;
  const token = signCapability({ kind: 'handoff', jti: randomUUID(), projectId, versionId: p.currentVersion, userId, role,
    host: p.host, revision: p.revision, permissionUntil, manifestHash: v.manifestHash, nonce }, 'website-preview-handoff', POLICY.handoffSeconds);
  return { token, origin: `https://${p.host}`, nonce, permissionUntil, renewMs: POLICY.renewMs };
}
async function redeem(token) {
  const c = verifyCapability(token, 'website-preview-handoff');
  if (c.kind !== 'handoff' || c.permissionUntil <= Date.now() / 1000 || c.permissionUntil > c.iat + POLICY.permissionSeconds) fail('Preview permission expired', 401);
  let data;
  await tx(async session => {
    const { admin } = await access(c.projectId, c.userId, c.role, false, session);
    const p = await Preview.findById(c.projectId).session(session).lean();
    if (!p || p.host !== c.host || p.currentVersion !== c.versionId || p.revision !== c.revision || (!admin && !p.visible)) fail('Preview permission changed', 403);
    const v = await Version.findOne({ _id: c.versionId, projectId: c.projectId, state: 'ready' }).select('manifestHash').session(session).lean();
    if (!v || v.manifestHash !== c.manifestHash) fail('Preview version unavailable', 404);
    try { await Receipt.create([{ _id: `handoff:${c.jti}`, expiresAt: new Date(c.permissionUntil * 1000 + 60_000) }], { session }); }
    catch (e) { if (e.code === 11000) fail('Preview handoff already used', 409); throw e; }
    data = { claims: c };
  });
  return data;
}
async function freeze(body) {
  const c = verifyCapability(body.capability, 'website-preview-upload');
  await access(c.projectId, c.adminId, 'admin', true);
  const leaseId = randomUUID();
  const v = await Version.findOneAndUpdate({ _id: c.versionId, projectId: c.projectId, state: 'uploading', expiresAt: { $gt: new Date() } },
    { $set: { state: 'verifying', leaseId, leaseUntil: new Date(Date.now() + POLICY.leaseMs) } }, { new: true }).lean();
  if (!v) {
    const old = await Version.findById(c.versionId).select('state').lean();
    if (old?.state === 'ready') return { ready: true };
    fail('Upload cannot be verified in its current state', 409);
  }
  return { ...c, leaseId, manifest: v.manifest.map(({ path, key, size, contentType }) => ({ path, key, size, contentType })) };
}
async function finish(body) {
  const { versionId, leaseId } = body;
  let idempotent = false;
  await tx(async session => {
    const v = await Version.findById(versionId).session(session);
    if (!v) fail('Upload not found', 404);
    if (v.state === 'ready' && v.leaseId === leaseId) { idempotent = true; return; }
    if (v.state !== 'verifying' || v.leaseId !== leaseId || v.leaseUntil <= new Date()) fail('Verification lease expired', 409);
    await access(String(v.projectId), String(v.adminId), 'admin', true, session);
    const p = await Preview.findById(v.projectId).session(session);
    if (!p || p.currentVersion !== v.expectedVersion) fail('Another website version was activated first', 409);
    p.previousVersion = p.currentVersion; p.currentVersion = v._id; p.revision++;
    v.state = 'ready'; v.readyAt = new Date();
    await p.save({ session }); await v.save({ session });
  });
  return { ready: true, idempotent };
}
async function failed(body) {
  await Version.updateOne({ _id: body.versionId, state: 'verifying', leaseId: body.leaseId }, { $set: { state: 'failed', error: 'Website verification failed' } });
  return { failed: true };
}
async function cleanupClaims(projectId, userId, role) {
  await access(projectId, userId, role, true);
  await Version.updateMany({ projectId, state: 'uploading', expiresAt: { $lt: new Date() } }, { $set: { state: 'abandoned' } });
  await Version.updateMany({ projectId, state: 'verifying', leaseUntil: { $lt: new Date() } }, { $set: { state: 'failed' } });
  const versions = await Version.find({ projectId, state: { $in: ['failed', 'abandoned', 'ready', 'deleting'] }, updatedAt: { $lt: new Date(Date.now() - 24 * 3600_000) },
    $or: [{ latestTokenExpiry: null }, { latestTokenExpiry: { $lt: new Date(Date.now() - 120_000) } }] }).limit(20).lean();
  const claims = [];
  for (const candidate of versions) await tx(async session => {
    const p = await Preview.findById(projectId).session(session);
    if (!p || [p.currentVersion, p.previousVersion].includes(candidate._id)) return;
    // Touch the authoritative pointer record so concurrent activation/cleanup conflict in MongoDB.
    await Preview.updateOne({ _id: projectId }, { $inc: { revision: 1 } }, { session });
    const cleanupId = candidate.cleanupId || randomUUID();
    const v = await Version.findOneAndUpdate({ _id: candidate._id, state: candidate.state }, { $set: { state: 'deleting', cleanupId } }, { new: true, session }).lean();
    if (v) claims.push(signCapability({ kind: 'cleanup', projectId, versionId: v._id, cleanupId, prefix: `website-previews/${projectId}/${v._id}/` }, 'website-preview-cleanup', 600));
  });
  return { claims };
}
async function cleanupDone(body) {
  const c = verifyCapability(body.capability, 'website-preview-cleanup');
  await Version.updateOne({ _id: c.versionId, state: 'deleting', cleanupId: c.cleanupId }, { $set: { state: 'deleted' }, $unset: { manifest: 1 } });
  return { deleted: true };
}
module.exports = { access, state, settings, begin, uploadBatch, grant, redeem, freeze, finish, failed, cleanupClaims, cleanupDone };
