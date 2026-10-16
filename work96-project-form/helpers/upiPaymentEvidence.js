const transactionModel = require("../models/transactionModel");

const UPI_REFERENCE_PATTERN = /^\d{12,}$/;
const normalizeUpiReference = (value) => String(value || "").trim();

const prepareUpiPaymentEvidence = async ({ reference, transactionId, capturedVia }) => {
  const upiReferenceKey = normalizeUpiReference(reference);
  if (!UPI_REFERENCE_PATTERN.test(upiReferenceKey)) {
    const error = new Error("UPI reference ID must contain at least 12 digits");
    error.statusCode = 400;
    throw error;
  }

  const existing = await transactionModel.findOne({
    paymentMethod: "upi",
    transactionId: { $ne: transactionId || null },
    $or: [
      { "paymentEvidence.upiReferenceKey": upiReferenceKey },
      { upiTransactionId: upiReferenceKey },
    ],
  }).select("_id").lean();
  if (existing) {
    const error = new Error("This UPI reference ID is already recorded");
    error.statusCode = 409;
    throw error;
  }

  return { upiReference: upiReferenceKey, upiReferenceKey, capturedVia, capturedAt: new Date() };
};

module.exports = { normalizeUpiReference, prepareUpiPaymentEvidence };
