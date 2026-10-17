const crypto = require("crypto");
const externalUploadLinkModel = require("../../models/externalUploadLinkModel");
const submitUpdateRequest = require("./submitUpdateRequest");
const upload = require("../../middleware/uploadFiles");
const { digestExternalUploadToken } = require("../../helpers/externalUploadToken");
const { resolveEligibleUploadTarget } = require("../../helpers/externalUploadLinkPolicy");
const { resolveExternalUploadAccess } = require("../../helpers/externalUploadAccessPolicy");
const {
  verifyClientCredentials,
  issueExternalUploadSession,
  readExternalUploadSession,
  clearExternalUploadSession,
  SESSION_STAGE,
  AUTH_MODE,
} = require("../../helpers/externalUploadSession");
const { UPLOAD_KIND } = require("../../helpers/uploadType");
const { assertProjectAcceptsUpload } = require("../../helpers/projectUploadGate");
const { isAllowedOrigin } = require("../../config/allowedOrigins");
const {
  MAX_PROJECT_FILES_PER_UPLOAD,
  MAX_UPLOAD_FILE_SIZE_BYTES,
} = require("../../config/uploadLimits");

const CREDENTIAL_WINDOW_MS = 15 * 60 * 1000;
const CREDENTIAL_MAX_FAILURES = 5;
const SINGLE_USE_RESERVATION_MS = 30 * 60 * 1000;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const sendError = (res, error) => res.status(error.status || 400).json({
  success: false,
  error: true,
  message: error.message || "External upload request failed",
});

const assertActiveCustomer = (customer) => {
  if (customer.isActive === false) throw fail("Client account is not active", 403);
};

const requireAllowedOrigin = (req, res, next) => {
  if (isAllowedOrigin(req.get("origin"))) return next();
  return sendError(res, fail("Request origin is not allowed", 403));
};

const exchange = async (req, res) => {
  try {
    const tokenDigest = digestExternalUploadToken(req.body?.token);
    const link = await externalUploadLinkModel.findOne({ tokenDigest, status: "active" }).lean();
    if (!link) throw fail("Upload link is invalid or no longer active", 404);
    const context = await resolveEligibleUploadTarget({ customerId: link.customerId, orderId: link.orderId });
    assertActiveCustomer(context.customer);

    const loginFree = context.customer.allowLoginFreeUploadLinks === true;
    issueExternalUploadSession({
      res,
      linkId: link._id,
      customerId: link.customerId,
      orderId: link.orderId,
      stage: loginFree ? SESSION_STAGE.ACCESS : SESSION_STAGE.CHALLENGE,
      authMode: loginFree ? AUTH_MODE.LINK : null,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, error: false, data: { requiresCredentials: !loginFree } });
  } catch (error) {
    return sendError(res, error);
  }
};

const recordCredentialFailure = async (linkId, link) => {
  const now = new Date();
  const windowStart = link.credentialFailureWindowStartedAt;
  const windowExpired = !windowStart || now.getTime() - new Date(windowStart).getTime() >= CREDENTIAL_WINDOW_MS;
  if (windowExpired) {
    await externalUploadLinkModel.updateOne(
      { _id: linkId },
      { $set: { credentialFailureCount: 1, credentialFailureWindowStartedAt: now, credentialBlockedUntil: null } },
    );
    return false;
  }

  const updated = await externalUploadLinkModel.findByIdAndUpdate(
    linkId,
    { $inc: { credentialFailureCount: 1 } },
    { new: true },
  ).select("+credentialFailureCount");
  if (Number(updated?.credentialFailureCount || 0) < CREDENTIAL_MAX_FAILURES) return false;
  await externalUploadLinkModel.updateOne(
    { _id: linkId },
    { $set: { credentialBlockedUntil: new Date(now.getTime() + CREDENTIAL_WINDOW_MS) } },
  );
  return true;
};

const verifyCredentials = async (req, res) => {
  try {
    const session = readExternalUploadSession(req);
    const context = await resolveExternalUploadAccess({ session, requiredStage: SESSION_STAGE.CHALLENGE });
    const link = await externalUploadLinkModel.findById(context.link._id)
      .select("+credentialFailureCount +credentialFailureWindowStartedAt +credentialBlockedUntil")
      .lean();
    if (link?.credentialBlockedUntil && new Date(link.credentialBlockedUntil) > new Date()) {
      throw fail("Too many failed attempts. Try again later.", 429);
    }

    const valid = await verifyClientCredentials({
      customerId: context.customer._id,
      email: req.body?.email,
      password: req.body?.password,
    });
    if (!valid) {
      const blocked = await recordCredentialFailure(context.link._id, link || {});
      throw fail(blocked ? "Too many failed attempts. Try again later." : "Invalid client credentials", blocked ? 429 : 401);
    }

    await externalUploadLinkModel.updateOne(
      { _id: context.link._id },
      { $set: { credentialFailureCount: 0, credentialFailureWindowStartedAt: null, credentialBlockedUntil: null } },
    );
    issueExternalUploadSession({
      res,
      linkId: context.link._id,
      customerId: context.customer._id,
      orderId: context.order._id,
      stage: SESSION_STAGE.ACCESS,
      authMode: AUTH_MODE.CREDENTIALS,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, error: false });
  } catch (error) {
    return sendError(res, error);
  }
};

const requireAccess = async (req, res, next) => {
  try {
    const session = readExternalUploadSession(req);
    const context = await resolveExternalUploadAccess({ session });
    req.externalUpload = { session, ...context };
    return next();
  } catch (error) {
    clearExternalUploadSession(res);
    return sendError(res, fail(error.message || "External upload access is not verified", 401));
  }
};

const buildContextPayload = async ({ order, kind }) => {
  const snapshot = order.servicePlanSnapshot || {};
  let refusal = null;
  let maxFiles = MAX_PROJECT_FILES_PER_UPLOAD;
  let remainingUploads = null;

  if (kind === UPLOAD_KIND.PROJECT) {
    refusal = await assertProjectAcceptsUpload(order);
  } else {
    maxFiles = Number(snapshot.filesLimit || 0);
    if (order.servicePlanStatus !== "active") refusal = "This service is not active";
    if (snapshot.limitScope !== "unlimited") {
      remainingUploads = Math.max(0, Number(snapshot.portalAccessCount || 0) - Number(order.serviceAccessUsedInCycle || 0));
      if (remainingUploads === 0) refusal = "Selected service upload limit is used";
    }
  }
  if (!refusal && order.planStatus === "closed") refusal = "This record has been closed";
  if (!refusal && order.autoRenewalStatus === "paused") refusal = "This record is paused because payment is overdue";
  if (!refusal && !order.isActive) refusal = "This record is not active";

  return {
    target: {
      id: String(order._id),
      kind,
      name: order.projectSnapshot?.displayName || snapshot.serviceName || order.orderItems?.[0]?.name || "Upload Data",
    },
    limits: {
      maxFiles,
      maxFileSizeBytes: MAX_UPLOAD_FILE_SIZE_BYTES,
      remainingUploads,
      extensions: [".jpg", ".jpeg", ".txt", ".rtf", ".pdf", ".doc", ".docx"],
    },
    canUpload: !refusal,
    refusal,
  };
};

const getSession = async (req, res) => {
  try {
    const session = readExternalUploadSession(req);
    if (!session) throw fail("Upload-link session is unavailable", 401);
    if (session.stage === SESSION_STAGE.CHALLENGE) {
      await resolveExternalUploadAccess({ session, requiredStage: SESSION_STAGE.CHALLENGE });
      res.set("Cache-Control", "no-store");
      return res.json({ success: true, error: false, data: { requiresCredentials: true, context: null } });
    }
    const context = await resolveExternalUploadAccess({ session });
    const payload = await buildContextPayload(context);
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, error: false, data: { requiresCredentials: false, context: payload } });
  } catch (error) {
    clearExternalUploadSession(res);
    return sendError(res, fail(error.message || "Upload-link session is unavailable", 401));
  }
};

const reserveSingleUse = async (req, res, next) => {
  const link = req.externalUpload.link;
  if (link.mode !== "single") return next();
  try {
    const now = new Date();
    const reservationId = crypto.randomUUID();
    const reserved = await externalUploadLinkModel.findOneAndUpdate(
      {
        _id: link._id,
        status: "active",
        $or: [
          { reservationId: null },
          { reservationExpiresAt: { $lte: now } },
        ],
      },
      { $set: { reservationId, reservationExpiresAt: new Date(now.getTime() + SINGLE_USE_RESERVATION_MS) } },
      { new: true },
    ).select("+reservationId +reservationExpiresAt");
    if (!reserved) throw fail("This single-use link is already being used", 409);
    req.externalUpload.reservationId = reservationId;
    return next();
  } catch (error) {
    return sendError(res, error);
  }
};

const releaseReservation = async (req) => {
  const reservationId = req.externalUpload?.reservationId;
  if (!reservationId) return;
  await externalUploadLinkModel.updateOne(
    { _id: req.externalUpload.link._id, status: "active", reservationId },
    { $set: { reservationId: null, reservationExpiresAt: null } },
  );
};

const parseFiles = (req, res, next) => upload.any()(req, res, async (error) => {
  if (!error) return next();
  await releaseReservation(req).catch(() => {});
  return sendError(res, fail(error.message || "Invalid upload", 400));
});

const recordSuccessfulUse = async (req) => {
  const { link, reservationId } = req.externalUpload;
  if (link.mode === "single") {
    const result = await externalUploadLinkModel.updateOne(
      { _id: link._id, status: "active", reservationId },
      {
        $set: { status: "used", lastUsedAt: new Date(), reservationId: null, reservationExpiresAt: null },
        $inc: { useCount: 1 },
      },
    );
    if (result.modifiedCount !== 1) throw fail("Single-use link could not be completed", 409);
    return;
  }
  await externalUploadLinkModel.updateOne(
    { _id: link._id },
    { $set: { lastUsedAt: new Date() }, $inc: { useCount: 1 } },
  );
};

const applyExternalUploadIdentity = (req) => {
  const { order, kind, customer } = req.externalUpload;
  req.userId = String(customer._id);
  req.body = { ...req.body, planId: String(order._id) };
  if (kind === UPLOAD_KIND.SERVICE) req.body.serviceOrderId = String(order._id);
  else delete req.body.serviceOrderId;
};

const submit = async (req, res, next) => {
  try {
    const refreshed = await resolveExternalUploadAccess({ session: req.externalUpload.session });
    req.externalUpload = { ...req.externalUpload, ...refreshed };
    applyExternalUploadIdentity(req);
  } catch (error) {
    await releaseReservation(req).catch(() => {});
    clearExternalUploadSession(res);
    return sendError(res, fail(error.message || "Upload link is no longer available", 401));
  }

  let responseStatus = 200;
  const proxyRes = {
    status(value) { responseStatus = value; return this; },
    json: async (payload) => {
      if (payload?.success) {
        await recordSuccessfulUse(req);
        if (req.externalUpload.link.mode === "single") clearExternalUploadSession(res);
      }
      else await releaseReservation(req);
      return res.status(responseStatus).json(payload);
    },
  };

  try {
    return await submitUpdateRequest(req, proxyRes, next);
  } catch (error) {
    await releaseReservation(req).catch(() => {});
    return sendError(res, error);
  }
};

module.exports = {
  requireAllowedOrigin,
  exchange,
  verifyCredentials,
  requireAccess,
  getSession,
  reserveSingleUse,
  parseFiles,
  submit,
  applyExternalUploadIdentity,
};
