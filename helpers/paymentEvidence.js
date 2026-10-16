const transactionModel = require("../models/transactionModel");
const { prepareUpiPaymentEvidence } = require("./upiPaymentEvidence");

// Payment-method SSOT for every payment an ADMIN records by hand (create project, approve
// project, mark invoice paid, wallet recharge). Each method asks for exactly what that method
// actually produces — no generic "reference" box:
//   cash / wallet   → nothing
//   upi             → UPI reference, digits only, at least 12 (upiPaymentEvidence.js)
//   bank_transfer   → transfer mode (NEFT/IMPS/RTGS) + transaction ID / UTR, letters + numbers
//   cheque          → 6-digit cheque number + drawee bank name + cheque date
// The frontend mirror is frontend/src/helpers/paymentMethodRules.js — keep the two in step.
const ADMIN_PAYMENT_METHODS = ["upi", "bank_transfer", "cheque", "cash", "wallet"];
const BANK_TRANSFER_MODES = ["neft", "imps", "rtgs"];
const BANK_REFERENCE_PATTERN = /^[A-Z0-9]{6,22}$/;
const CHEQUE_NUMBER_PATTERN = /^\d{6}$/;

const badRequest = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// Same duplicate rule UPI already has: one external payment reference may back one record only.
const assertUnusedEvidence = async (field, key, transactionId, message) => {
  const existing = await transactionModel.findOne({
    [`paymentEvidence.${field}`]: key,
    transactionId: { $ne: transactionId || null },
  }).select("_id").lean();
  if (existing) throw badRequest(message, 409);
};

// Validates what the admin entered for `paymentMethod` and returns the normalized reference plus
// the paymentEvidence sub-document to store on the transaction. Throws a 400/409 error the
// caller returns as-is. Methods outside the admin list (combined, reward, demo — system-made
// payments) carry no evidence and pass through untouched.
const preparePaymentEvidence = async ({
  paymentMethod,
  reference,
  details = {},
  transactionId = null,
  capturedVia = "admin",
}) => {
  const capturedAt = new Date();

  if (paymentMethod === "upi") {
    const paymentEvidence = await prepareUpiPaymentEvidence({ reference, transactionId, capturedVia });
    return { reference: paymentEvidence.upiReference, paymentEvidence };
  }

  if (paymentMethod === "bank_transfer") {
    const mode = String(details?.transferMode || "").trim().toLowerCase();
    if (!BANK_TRANSFER_MODES.includes(mode)) {
      throw badRequest("Choose the bank transfer mode (NEFT, IMPS or RTGS)");
    }
    const bankReference = String(reference || "").trim().toUpperCase();
    if (!BANK_REFERENCE_PATTERN.test(bankReference)) {
      throw badRequest("Transaction ID / UTR must be 6–22 letters or numbers, without spaces or symbols");
    }
    await assertUnusedEvidence("bankReferenceKey", bankReference, transactionId, "This transaction ID / UTR is already recorded");
    return {
      reference: bankReference,
      paymentEvidence: { bankTransferMode: mode, bankReference, bankReferenceKey: bankReference, capturedVia, capturedAt },
    };
  }

  if (paymentMethod === "cheque") {
    const chequeNumber = String(reference || "").trim();
    if (!CHEQUE_NUMBER_PATTERN.test(chequeNumber)) {
      throw badRequest("Cheque number must be exactly 6 digits");
    }
    const chequeBankName = String(details?.chequeBankName || "").trim().replace(/\s+/g, " ");
    if (chequeBankName.length < 2 || chequeBankName.length > 80) {
      throw badRequest("Enter the bank name printed on the cheque");
    }
    const chequeDate = details?.chequeDate ? new Date(details.chequeDate) : null;
    if (!chequeDate || Number.isNaN(chequeDate.getTime())) {
      throw badRequest("Enter the cheque date");
    }
    // Cheque numbers repeat across banks, so a cheque is identified by bank + number.
    const chequeKey = `${chequeBankName.toLowerCase()}:${chequeNumber}`;
    await assertUnusedEvidence("chequeKey", chequeKey, transactionId, "This cheque is already recorded");
    return {
      reference: chequeNumber,
      paymentEvidence: { chequeNumber, chequeBankName, chequeDate, chequeKey, capturedVia, capturedAt },
    };
  }

  return { reference: null, paymentEvidence: undefined };
};

module.exports = {
  ADMIN_PAYMENT_METHODS,
  BANK_TRANSFER_MODES,
  preparePaymentEvidence,
};
