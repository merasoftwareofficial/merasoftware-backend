const externalUploadLinkModel = require("../models/externalUploadLinkModel");
const { resolveEligibleUploadTarget } = require("./externalUploadLinkPolicy");
const { SESSION_STAGE, AUTH_MODE } = require("./externalUploadSession");

// A signed cookie is only a short-lived reference. Every protected external-upload
// request resolves the live link and client again, so revoke, regenerate, account
// status, and consent changes take effect without waiting for the cookie to expire.
const resolveExternalUploadAccess = async ({ session, requiredStage = SESSION_STAGE.ACCESS }) => {
  if (!session || session.stage !== requiredStage) throw new Error("External upload access is not verified");

  const link = await externalUploadLinkModel.findOne({
    _id: session.linkId,
    customerId: session.customerId,
    orderId: session.orderId,
    status: "active",
  }).lean();
  if (!link) throw new Error("Upload link is no longer active");

  const context = await resolveEligibleUploadTarget({ customerId: session.customerId, orderId: session.orderId });
  if (context.customer.isActive === false) throw new Error("Client account is not active");
  if (session.stage === SESSION_STAGE.ACCESS
      && session.authMode === AUTH_MODE.LINK
      && context.customer.allowLoginFreeUploadLinks !== true) {
    throw new Error("Client credential verification is required");
  }

  return { ...context, link };
};

module.exports = { resolveExternalUploadAccess };
