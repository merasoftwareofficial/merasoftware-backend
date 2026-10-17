const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Submission = require('../models/uploadSubmissionModel');
const UpdateRequest = require('../models/updateRequestModel');
const Order = require('../models/orderProductModel');
const Link = require('../models/externalUploadLinkModel');
const { assertProjectAcceptsUpload } = require('./projectUploadGate');
const { UPLOAD_KIND, getUploadKind } = require('./uploadType');
const { measureUpload } = require('./uploadTiming');

const failure = (message, status = 409) => Object.assign(new Error(message), { status });
function uploadIdentity(req) {
  const uploadId = req.query?.uploadId || req.params?.uploadId;
  if (!uploadId) return null; // Compatibility for older clients, no retry guarantee.
  if (typeof uploadId !== 'string' || !/^[a-f0-9-]{36}$/i.test(uploadId)) throw failure('Invalid upload identifier', 400);
  const external = req.externalUpload;
  return {
    ownerId: req.userId || external?.session?.customerId,
    scope: external ? `external:${external.session.linkId}` : 'portal',
    uploadId,
  };
}

function fingerprint(req) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify([req.body.planId, req.body.serviceOrderId || '', req.body.instructions || '']));
  for (const file of req.files || []) {
    hash.update(JSON.stringify([file.originalname, file.mimetype, file.size]));
    hash.update(crypto.createHash('sha256').update(file.buffer).digest());
  }
  return hash.digest('hex');
}

async function findSubmission(req) {
  const identity = uploadIdentity(req);
  return identity ? Submission.findOne(identity).lean() : null;
}

async function claimSubmission(req) {
  const identity = uploadIdentity(req);
  if (!identity) return null;
  await Submission.init(); // The unique index must exist before allowing concurrent claims.
  const digest = fingerprint(req);
  const values = { ...identity, fingerprint: digest, totalFiles: req.files?.length || 0, attemptToken: crypto.randomUUID() };
  let document;
  try { document = await Submission.create(values); }
  catch (error) {
    if (error.code !== 11000) throw error;
    const previous = await Submission.findOne(identity).lean();
    if (!previous || previous.fingerprint !== digest) throw failure('This upload identifier belongs to different data. Start a new submission.');
    if (previous.status === 'succeeded') return { replay: previous.result };
    if (previous.status === 'failed') {
      document = await Submission.findOneAndUpdate({ _id: previous._id, status: 'failed' }, {
        $set: { status: 'processing', phase: 'saving_files', completedFiles: 0, attemptToken: values.attemptToken },
      }, { new: true });
    }
    if (!document) return { pending: true, status: previous.status };
  }
  return { document, filter: { _id: document._id, attemptToken: document.attemptToken, status: 'processing' } };
}

async function progress(req, update) {
  if (!req.uploadAttempt?.filter) return;
  await Submission.updateOne(req.uploadAttempt.filter, update).catch(() => {
    console.warn('[upload] Progress update unavailable');
  });
}

async function failSubmission(req, needsReview = false) {
  if (req.uploadAttempt?.filter) await Submission.updateOne(req.uploadAttempt.filter, {
    $set: { status: needsReview ? 'needs_review' : 'failed', phase: needsReview ? 'needs_review' : 'failed' },
  });
}

// Files stay on Drive; all related Mongo writes commit together. Never retry
// an uncertain file creation automatically, and never delete possibly committed files.
async function commitSubmission(req, { instructions, files }) {
  const attempt = req.uploadAttempt;
  const requestId = new mongoose.Types.ObjectId();
  let response;
  try {
    await mongoose.connection.transaction(async session => {
      const current = await Order.findOne({ _id: req.body.planId, userId: req.userId }).session(session).populate('productId');
      if (!current || !current.isActive || current.planStatus === 'closed' || current.autoRenewalStatus === 'paused') {
        throw failure('This order no longer accepts uploads', 400);
      }
      const kind = getUploadKind(current);
      let remaining = null;
      if (kind === UPLOAD_KIND.PROJECT) {
        const refusal = await assertProjectAcceptsUpload(current);
        if (refusal) throw failure(refusal, 400);
        // Touch the order so competing order changes conflict with this commit.
        await Order.updateOne({ _id: current._id }, { $inc: { uploadRevision: 1 } }, { session });
      } else if (kind === UPLOAD_KIND.SERVICE) {
        const snapshot = current.servicePlanSnapshot || {};
        if (current.servicePlanStatus !== 'active'
          || (snapshot.capability !== 'upload_data' && snapshot.serviceBehavior !== 'portal_access_control')
          || files.length > Number(snapshot.filesLimit || 0)) throw failure('Selected service no longer accepts this upload', 400);
        const filter = { _id: current._id, servicePlanStatus: 'active' };
        if (snapshot.limitScope !== 'unlimited') filter.$expr = { $lt: [{ $ifNull: ['$serviceAccessUsedInCycle', 0] }, Number(snapshot.portalAccessCount || 0)] };
        const reserved = await Order.updateOne(filter, { $inc: { serviceAccessUsedInCycle: 1, serviceAccessUsedTotal: 1 } }, { session });
        if (reserved.modifiedCount !== 1) throw failure('Selected service upload allowance is used', 400);
      } else {
        const limit = Number(current.productId?.updateCount || 0);
        if (current.updatesUsed >= limit) throw failure('No updates remaining in this plan', 400);
        const fields = { updatesUsed: 1 };
        const set = {};
        if (current.productId?.isMonthlyRenewablePlan || current.productId?.isMonthlyLimitedPlan) fields.currentMonthUpdatesUsed = 1;
        if (current.productId?.isMonthlyLimitedPlan) {
          const monthlyLimit = current.currentMonthUpdatesLimit || current.productId.monthlyUpdateLimit || 1;
          if (Number(current.currentMonthUpdatesUsed || 0) >= monthlyLimit) throw failure('Monthly upload allowance is used', 400);
          const expiry = current.currentMonthExpiryDate;
          if (expiry && new Date() > expiry) throw failure('Your monthly period has expired', 400);
          set.currentMonthUpdatesRemaining = monthlyLimit - (Number(current.currentMonthUpdatesUsed || 0) + 1);
        }
        await Order.updateOne({ _id: current._id }, { $inc: fields, ...(Object.keys(set).length ? { $set: set } : {}) }, { session });
        remaining = limit - (current.updatesUsed + 1);
      }
      await measureUpload(req.uploadTiming, 'request_save', () => UpdateRequest.create([{
        _id: requestId, userId: req.userId, updatePlanId: current._id,
        instructions, files, status: 'pending',
      }], { session }));
      if (req.externalUpload) {
        const { link, reservationId } = req.externalUpload;
        const filter = { _id: link._id, status: 'active' };
        const set = { lastUsedAt: new Date() };
        if (link.mode === 'single') {
          filter.reservationId = reservationId;
          Object.assign(set, { status: 'used', reservationId: null, reservationExpiresAt: null });
        }
        const consumed = await Link.updateOne(filter, { $set: set, $inc: { useCount: 1 } }, { session });
        if (consumed.modifiedCount !== 1) throw failure('Upload link changed before completion');
      }
      response = { message: 'Update request submitted successfully', error: false, success: true,
        data: { requestId: String(requestId), updatesRemaining: remaining } };
      const finalized = await Submission.updateOne(attempt.filter, {
        $set: { status: 'succeeded', phase: 'complete', completedFiles: files.length, result: response },
      }, { session });
      if (finalized.modifiedCount !== 1) throw failure('Upload submission changed before completion');
    });
    return { response, requestId };
  } catch (error) {
    if (error.hasErrorLabel?.('UnknownTransactionCommitResult')) {
      error.uploadCommitUncertain = true;
      const saved = await Submission.findById(attempt.document._id).lean().catch(() => null);
      if (saved?.status === 'succeeded') return { response: saved.result, requestId: saved.result.data.requestId };
    }
    throw error;
  }
}

module.exports = { uploadIdentity, findSubmission, claimSubmission, progress, failSubmission, commitSubmission };
