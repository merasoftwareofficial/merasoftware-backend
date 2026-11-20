const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Submission = require('../models/uploadSubmissionModel');
const File = require('../models/stagedUploadFileModel');
const Budget = require('../models/uploadStorageBudgetModel');
const Order = require('../models/orderProductModel');
const Link = require('../models/externalUploadLinkModel');
const uploadPolicy = require('../middleware/uploadFiles');
const { uploadIdentity, commitSubmission } = require('./uploadSubmission');
const { assertUploadOrder } = require('./uploadOrderPolicy');
const { MAX_UPLOAD_FILE_SIZE_BYTES } = require('../config/uploadLimits');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const SESSION_MS = 25 * 60 * 1000;
const BUDGET_ID = 'temporary-upload-bytes';

function configuration() {
  const capacity = Number(process.env.UPLOAD_STAGING_MAX_BYTES);
  if (process.env.ENABLE_UPLOAD_WORKER !== 'true' || !Number.isSafeInteger(capacity) || capacity <= 0) {
    throw fail('Uploads are temporarily unavailable. Please try again later.', 503);
  }
  return capacity;
}

function identity(req) {
  const value = uploadIdentity(req);
  if (!value || !value.ownerId) throw fail('Upload identity is required', 400);
  return value;
}

async function load(req, session) {
  const query = Submission.findOne({ ...identity(req), mode: 'staged' });
  const record = await (session ? query.session(session) : query);
  if (!record) throw fail('Upload session not found', 404);
  return record;
}

function publicStatus(record) {
  return {
    uploadId: record.uploadId, status: record.status,
    files: (record.manifest || []).map(f => ({ id: f.id, name: f.name, size: f.size, received: f.received })),
    result: record.status === 'succeeded' ? record.result : undefined,
  };
}

async function begin(req) {
  const capacity = configuration();
  const key = identity(req);
  const source = req.body || {};
  if (!Array.isArray(source.files) || source.files.length > 100) throw fail('Invalid file list');
  const files = [];
  const ids = new Set();
  for (const item of source.files) {
    if (!item || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.id) || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[\\/\x00]/.test(item.name)
      || typeof item.type !== 'string' || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_UPLOAD_FILE_SIZE_BYTES
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw fail('Invalid file details');
    await new Promise((resolve, reject) => uploadPolicy.fileFilter(req, { originalname: item.name, mimetype: item.type }, error => error ? reject(fail(error.message)) : resolve()));
    ids.add(item.id);
    files.push({ id: item.id, name: item.name, type: item.type, size: item.size, sha256: item.sha256 });
  }
  if (!Array.isArray(source.instructions) || source.instructions.length > 100) throw fail('Invalid instructions');
  const instructions = source.instructions.map(note => {
    if (!note || typeof note.text !== 'string' || note.text.length > 100000) throw fail('Invalid instructions');
    const timestamp = new Date(note.timestamp || Date.now());
    if (!Number.isFinite(timestamp.getTime())) throw fail('Invalid instruction timestamp');
    return { text: note.text.trim(), timestamp };
  }).filter(note => note.text);
  if (!files.length && !instructions.length) throw fail('Add at least one file or instruction');
  const orderId = req.externalUpload ? String(req.externalUpload.order._id) : String(source.planId || '');
  if (!mongoose.isValidObjectId(orderId)) throw fail('Invalid upload order');
  const digest = crypto.createHash('sha256').update(JSON.stringify({ orderId, files, instructions: instructions.map(note => ({ text: note.text })) })).digest('hex');
  const previous = await Submission.findOne(key);
  if (previous) {
    if (previous.mode !== 'staged' || previous.fingerprint !== digest) throw fail('This upload identifier belongs to different data', 409);
    if (previous.status !== 'succeeded' && (previous.status !== 'processing' || previous.expiresAt <= new Date())) throw fail('Upload session has expired. Start a new submission.', 410);
    return previous;
  }
  const order = await Order.findOne({ _id: orderId, userId: key.ownerId }).populate('productId');
  await assertUploadOrder(order, { fileCount: files.length, serviceOrderId: req.externalUpload ? orderId : source.serviceOrderId });
  const bytes = files.reduce((total, file) => total + file.size, 0);
  await Promise.all([Submission.init(), File.init(), Budget.init()]);
  await Budget.updateOne({ _id: BUDGET_ID }, { $setOnInsert: { usedBytes: 0 } }, { upsert: true });
  let record;
  try {
    await mongoose.connection.transaction(async session => {
      const reserved = await Budget.updateOne({ _id: BUDGET_ID, usedBytes: { $lte: capacity - bytes } }, { $inc: { usedBytes: bytes } }, { session });
      if (reserved.matchedCount !== 1) throw fail('Upload storage is busy. Please try again later.', 507);
      [record] = await Submission.create([{
        ...key, mode: 'staged', orderId, instructions, manifest: files, fingerprint: digest,
        phase: 'receiving', status: 'processing', totalFiles: files.length,
        attemptToken: crypto.randomUUID(), reservedBytes: bytes, expiresAt: new Date(Date.now() + SESSION_MS),
        reservationId: req.externalUpload?.reservationId,
      }], { session });
    }, { writeConcern: { w: 'majority' } });
  } catch (error) {
    if (error.code !== 11000 && !error.hasErrorLabel?.('UnknownTransactionCommitResult')) throw error;
    record = await Submission.findOne(key);
    if (!record || record.fingerprint !== digest) throw error;
  }
  return record;
}

async function receive(req) {
  const record = await load(req);
  const manifest = record.manifest.find(file => file.id === req.params.fileId);
  if (!manifest) throw fail('File does not belong to this submission', 404);
  const file = req.file;
  if (!file || file.size !== manifest.size || file.mimetype !== manifest.type
    || crypto.createHash('sha256').update(file.buffer).digest('hex') !== manifest.sha256) throw fail('File content does not match the selected file');
  if (manifest.received) return record;
  if (record.status !== 'processing' || record.phase !== 'receiving' || record.expiresAt <= new Date()) throw fail('This upload session is no longer accepting files', 410);
  try {
    await mongoose.connection.transaction(async session => {
      const changed = await Submission.updateOne({ _id: record._id, status: 'processing', phase: 'receiving', expiresAt: { $gt: new Date() }, 'manifest.id': manifest.id }, {
        $set: { 'manifest.$[item].received': true }, $inc: { completedFiles: 1 },
      }, { session, arrayFilters: [{ 'item.id': manifest.id, 'item.received': false }] });
      if (changed.modifiedCount !== 1) throw fail('Upload session changed. Check its status before retrying.', 409);
      await File.create([{ submissionId: record._id, fileId: manifest.id, payload: file.buffer }], { session });
    }, { writeConcern: { w: 'majority' } });
  } catch (error) {
    if (error.code !== 11000 && !error.hasErrorLabel?.('UnknownTransactionCommitResult')) throw error;
    const saved = await File.exists({ submissionId: record._id, fileId: manifest.id });
    if (!saved) throw error;
  }
  return load(req);
}

async function accept(req) {
  const record = await load(req);
  if (record.status === 'succeeded') return { response: record.result, replay: true };
  configuration();
  if (record.status !== 'processing' || record.phase !== 'receiving' || record.expiresAt <= new Date()) throw fail('Upload session has expired', 410);
  if (record.manifest.some(file => !file.received) || await File.countDocuments({ submissionId: record._id }) !== record.totalFiles) throw fail('Some files have not been received yet', 409);
  req.userId = String(record.ownerId);
  req.body = { planId: String(record.orderId), serviceOrderId: String(record.orderId) };
  req.uploadAttempt = { document: record, filter: { _id: record._id, status: 'processing', phase: 'receiving', attemptToken: record.attemptToken } };
  if (req.externalUpload) req.externalUpload.reservationId = record.reservationId;
  const files = record.manifest.map(file => ({ filename: file.name.replace(/\s+/g, '_'), originalName: file.name, type: file.type, size: file.size }));
  try {
    const result = await commitSubmission(req, { instructions: record.instructions, files, receipt: true });
    return { ...result, replay: false };
  } catch (error) {
    const saved = await load(req).catch(() => null);
    if (saved?.status === 'succeeded') return { response: saved.result, replay: true };
    throw error;
  }
}

// Compare-and-set cleanup ownership prevents receipt acceptance racing expiration.
async function expireOne({ deleteDriveFile } = {}) {
  const expired = await Submission.findOneAndUpdate({ mode: 'staged', status: 'processing', expiresAt: { $lte: new Date() } }, {
    $set: { status: 'failed', phase: 'expired', delivery: 'cleaning' },
  }, { new: true });
  const record = expired || await Submission.findOne({ mode: 'staged', delivery: 'cleaning' });
  if (!record) return false;
  const stored = await File.find({ submissionId: record._id }).select('driveFileId').lean();
  for (const file of stored) {
    if (file.driveFileId) {
      if (!deleteDriveFile) return false;
      await deleteDriveFile(file.driveFileId); // Retain references when cleanup fails.
    }
  }
  await mongoose.connection.transaction(async session => {
    const current = await Submission.findOne({ _id: record._id, delivery: 'cleaning' }).session(session);
    if (!current) return;
    await File.deleteMany({ submissionId: record._id }, { session });
    await Budget.updateOne({ _id: BUDGET_ID }, { $inc: { usedBytes: -current.reservedBytes } }, { session });
    await Submission.updateOne({ _id: record._id }, { $set: { reservedBytes: 0, delivery: 'cancelled' } }, { session });
    if (record.scope.startsWith('external:') && record.reservationId) await Link.updateOne({ _id: record.scope.slice(9), status: 'active', reservationId: record.reservationId }, { $set: { reservationId: null, reservationExpiresAt: null } }, { session });
  });
  return true;
}

module.exports = { configuration, load, begin, receive, accept, publicStatus, expireOne, BUDGET_ID };
