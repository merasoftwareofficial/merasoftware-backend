const crypto = require('node:crypto');
const path = require('node:path');
const mongoose = require('mongoose');
const Submission = require('../models/uploadSubmissionModel');
const File = require('../models/stagedUploadFileModel');
const Budget = require('../models/uploadStorageBudgetModel');
const Request = require('../models/updateRequestModel');
const Order = require('../models/orderProductModel');
const AdminSettings = require('../models/adminSettingsModel');
const Drive = require('./googleDriveService');
const { uploadBatch } = require('./uploadConcurrency');
const { expireOne, BUDGET_ID, configuration } = require('./stagedUploads');
const LEASE_MS = 120000;

function driveService() {
  const credentials = process.env.NODE_ENV === 'production' && process.env.GOOGLE_DRIVE_CREDENTIALS_PATH
    ? process.env.GOOGLE_DRIVE_CREDENTIALS_PATH : path.join(__dirname, '../config/google-drive-credentials.json');
  return new Drive(credentials, 'ClientUpdateFiles');
}

async function runOnce({ drive = driveService(), now = new Date() } = {}) {
  await expireOne({ deleteDriveFile: id => drive.deleteFile(id) });
  const job = await Submission.findOneAndUpdate({ mode: 'staged', status: 'succeeded',
    $or: [ { delivery: 'queued', nextAttemptAt: { $lte: now } }, { delivery: 'running', leaseUntil: { $lte: now } } ],
  }, { $set: { delivery: 'running', workerToken: crypto.randomUUID(), leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } });
  if (!job) return false;
  const fence = { _id: job._id, delivery: 'running', workerToken: job.workerToken };
  const heartbeat = setInterval(() => {
    void Submission.updateOne(fence, { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(() => {});
  }, 10000);
  heartbeat.unref();
  try {
    const requestExists = await Request.exists({ _id: job.requestId, userId: job.ownerId });
    const orderExists = await Order.exists({ _id: job.orderId, userId: job.ownerId });
    if (!requestExists || !orderExists) {
      await Submission.updateOne(fence, { $set: { delivery: 'cleaning', deliveryFailure: 'Parent record removed' } });
      return true;
    }
    const settings = await AdminSettings.getSettings();
    const folderId = job.totalFiles ? await drive.createFolder() : null;
    const files = await uploadBatch(job.manifest, async item => {
      let stored = await File.findOne({ submissionId: job._id, fileId: item.id }).select('+payload');
      if (!stored) throw new Error('Received file is unavailable');
      if (!stored.driveResult) {
        if (!stored.driveFileId) {
          const generated = await drive.generateFileId();
          stored = await File.findOneAndUpdate({ _id: stored._id, driveFileId: null }, { $set: { driveFileId: generated } }, { new: true }).select('+payload')
            || await File.findById(stored._id).select('+payload');
        }
        const uploaded = await drive.uploadFile(item.name.replace(/\s+/g, '_'), stored.payload, item.type, folderId, () => false,
          { id: stored.driveFileId, sha256: item.sha256, retainOnError: true });
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + settings.fileExpirationDays);
        const result = { filename: item.name.replace(/\s+/g, '_'), originalName: item.name, type: item.type, size: item.size,
          driveFileId: uploaded.id, driveLink: uploaded.link, downloadLink: drive.getDownloadLink(uploaded.id),
          embedLink: item.type.startsWith('image/') ? drive.getEmbedableImageLink(uploaded.id)
            : ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(item.type) ? drive.getEmbedableDocumentLink(uploaded.id) : null,
          expirationDate };
        await File.updateOne({ _id: stored._id }, { $set: { driveResult: result } });
        return result;
      }
      return stored.driveResult;
    }, async () => {}); // Keep durable, pre-identified files for worker retries.
    await mongoose.connection.transaction(async session => {
      const owned = await Submission.findOne(fence).session(session);
      if (!owned) throw new Error('Upload worker lease changed');
      const updated = await Request.updateOne({ _id: job.requestId, userId: job.ownerId }, { $set: { files, deliveryStatus: 'ready' } }, { session });
      if (updated.matchedCount !== 1) throw new Error('Upload record was removed');
      await File.deleteMany({ submissionId: job._id }, { session });
      await Budget.updateOne({ _id: BUDGET_ID }, { $inc: { usedBytes: -owned.reservedBytes } }, { session });
      await Submission.updateOne(fence, { $set: { delivery: 'complete', reservedBytes: 0, deliveryFailure: '' }, $unset: { workerToken: '', leaseUntil: '' } }, { session });
    }, { writeConcern: { w: 'majority' } });
    console.info('[upload-worker]', JSON.stringify({ id: String(job._id), outcome: 'complete', fileCount: files.length }));
  } catch (error) {
    const terminal = job.attempts >= 8;
    const code = Number(error.code || error.response?.status) || 'processing_unavailable';
    const changed = await Submission.updateOne(fence, { $set: {
      delivery: terminal ? 'needs_review' : 'queued', deliveryFailure: String(code),
      nextAttemptAt: new Date(Date.now() + Math.min(300000, 5000 * 2 ** (job.attempts - 1))),
    }, $unset: { workerToken: '', leaseUntil: '' } });
    if (terminal && changed.modifiedCount) await Request.updateOne({ _id: job.requestId }, { $set: { deliveryStatus: 'needs_review' } });
    console.warn('[upload-worker]', JSON.stringify({ id: String(job._id), outcome: terminal ? 'needs_review' : 'retry', code }));
  } finally { clearInterval(heartbeat); }
  return true;
}

function startUploadWorker({ keepAlive = false } = {}) {
  if (process.env.ENABLE_UPLOAD_WORKER !== 'true') return;
  try { configuration(); }
  catch { console.error('[upload-worker] Configure UPLOAD_STAGING_MAX_BYTES before enabling uploads'); return; }
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runOnce(); } catch { console.warn('[upload-worker] Storage temporarily unavailable'); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 2000);
  if (!keepAlive) timer.unref();
  void tick();
  return () => clearInterval(timer);
}
module.exports = { runOnce, startUploadWorker };
