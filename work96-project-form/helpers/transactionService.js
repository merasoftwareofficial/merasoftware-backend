const transactionModel = require("../models/transactionModel");
const userModel = require("../models/userModel");
const { prepareUpiPaymentEvidence } = require("./upiPaymentEvidence");

// Shared transaction-creation SSOT.
//
// Historically the app created transactions inline in several places
// (verifyPaymentController.js, createRenewalOrder.js, invoiceLifecycle.js), each
// re-declaring the same shape. This helper is the single, param-driven way to create a
// customer payment transaction. NEW code should use it; the existing inline sites are
// intentionally left untouched for now (their renewal/combined/invoice shapes are
// nuanced and proven — they can migrate here later without changing behaviour).
//
// It mirrors verifyPaymentController.js's shape exactly for the common
// "customer submits a payment for approval" case:
//   - status 'pending', paymentStatus 'pending-approval'
//   - type 'payment' (order payments) or 'deposit' (wallet recharge, no orderId)
// and is idempotent on transactionId (an already-submitted id returns the existing doc,
// same guarantee verifyPaymentController.js gives).

const createPaymentTransaction = async ({
  userId,
  transactionId,
  amount,
  upiTransactionId = null,
  paymentMethod = "upi",
  orderId = null,
  invoiceId = null,
  installmentNumber = null,
  isInstallmentPayment = false,
  isPartialInstallmentPayment = false,
  description,
  // Set when this pending transaction is the PARENT of several child transactions
  // (one UPI payment covering N service-plan orders). Children carry the same value
  // and are settled together when this parent is approved. Default null keeps every
  // pre-existing caller byte-for-byte unchanged.
  parentTransactionId = null,
  // Overridable, but sensible defaults are derived below to match verifyPaymentController.
  type,
  sourceType,
  status = "pending",
  paymentStatus,
}) => {
  if (!userId) throw new Error("userId is required to create a transaction");
  if (!transactionId) throw new Error("transactionId is required");
  if (!(Number(amount) > 0)) throw new Error("A positive amount is required");

  // Idempotency: an already-submitted transaction id is treated as success and its
  // existing document returned (same behaviour as verifyPaymentController.js).
  const existing = await transactionModel.findOne({ transactionId });
  if (existing) return existing;

  const paymentEvidence = paymentMethod === "upi"
    ? await prepareUpiPaymentEvidence({ reference: upiTransactionId, transactionId, capturedVia: "customer" })
    : undefined;

  // Wallet recharge = a customer top-up with no order behind it.
  const isWalletRecharge = !isInstallmentPayment && !orderId;

  const resolvedType = type || (isWalletRecharge ? "deposit" : "payment");
  const resolvedSourceType =
    sourceType ||
    (invoiceId ? "invoice" : null) ||
    (isWalletRecharge ? "wallet" : null) ||
    (installmentNumber ? "installment" : "order");
  // Wallet recharges carry no paymentStatus (null); order payments await approval.
  const resolvedPaymentStatus =
    paymentStatus !== undefined
      ? paymentStatus
      : isWalletRecharge
      ? null
      : "pending-approval";

  const user = await userModel.findById(userId).select("referredBy");
  const referredBy = user ? user.referredBy : null;

  const transaction = new transactionModel({
    userId,
    transactionId,
    amount: Number(amount),
    upiTransactionId,
    paymentEvidence,
    type: resolvedType,
    description,
    status,
    paymentStatus: resolvedPaymentStatus,
    paymentMethod,
    sourceType: resolvedSourceType,
    date: new Date(),
    isInstallmentPayment: !!isInstallmentPayment || !!orderId,
    orderId,
    invoiceId,
    installmentNumber: installmentNumber ? Number(installmentNumber) : null,
    isPartialInstallmentPayment,
    parentTransactionId,
    referredBy,
  });

  await transaction.save();
  return transaction;
};

// Instantly deduct the customer's own wallet balance for a payment — NO admin approval.
//
// The wallet is the customer's own money (every rupee in it came from an admin-approved
// recharge, see doc 23), so spending it needs no second approval. This is the SSOT-safe
// version of the old, removed "direct deduction" (renewMonthlyPlan.js) that was a loophole
// ONLY because it never actually debited the balance and trusted a client-sent "paid" flag.
// Here the SERVER debits atomically and records a completed transaction:
//   - findOneAndUpdate with a `walletBalance >= amount` guard makes the debit race-safe and
//     impossible to overdraw (a concurrent debit that would overdraw simply matches nothing).
//   - a `type:'payment', status:'completed'` transaction is the audit record + wallet-history row.
// Throws if the balance can't cover the amount. Returns { transaction, newBalance }.
const deductWalletInstant = async ({
  userId,
  transactionId,
  amount,
  orderId = null,
  installmentNumber = null,
  isInstallmentPayment = false,
  description,
  parentTransactionId = null,
  sourceType,
}) => {
  if (!userId) throw new Error("userId is required for wallet deduction");
  if (!transactionId) throw new Error("transactionId is required");
  if (!(Number(amount) > 0)) throw new Error("A positive amount is required");

  // Idempotency: if this debit's transaction already exists, don't debit twice.
  const existing = await transactionModel.findOne({ transactionId });
  if (existing) {
    const current = await userModel.findById(userId).select("walletBalance");
    return { transaction: existing, newBalance: current?.walletBalance || 0 };
  }

  // Atomic, guarded debit — only succeeds if the balance can fully cover the amount.
  const updatedUser = await userModel.findOneAndUpdate(
    { _id: userId, walletBalance: { $gte: Number(amount) } },
    { $inc: { walletBalance: -Number(amount) } },
    { new: true }
  );
  if (!updatedUser) {
    throw new Error("Insufficient wallet balance");
  }

  const transaction = new transactionModel({
    userId,
    transactionId,
    amount: Number(amount),
    upiTransactionId: `WALLET-${transactionId}`,
    type: "payment",
    description,
    status: "completed",
    paymentStatus: "approved",
    paymentMethod: "wallet",
    sourceType: sourceType || (installmentNumber ? "installment" : "order"),
    date: new Date(),
    verificationDate: new Date(),
    isInstallmentPayment: !!isInstallmentPayment || !!orderId,
    orderId,
    installmentNumber: installmentNumber ? Number(installmentNumber) : null,
    parentTransactionId,
    referredBy: updatedUser.referredBy || null,
  });

  await transaction.save();
  return { transaction, newBalance: updatedUser.walletBalance };
};

// Refund a wallet debit back to the customer's balance — used when a combined payment's
// UPI portion is later rejected but its wallet portion was already instantly debited.
// Atomic credit + a `type:'refund', status:'completed'` audit record. Idempotent on
// transactionId so a re-run (e.g. a retried rejection) never double-refunds.
const refundWalletInstant = async ({
  userId,
  transactionId,
  amount,
  description,
  parentTransactionId = null,
  orderId = null,
}) => {
  if (!userId) throw new Error("userId is required for wallet refund");
  if (!transactionId) throw new Error("transactionId is required");
  if (!(Number(amount) > 0)) throw new Error("A positive amount is required");

  const existing = await transactionModel.findOne({ transactionId });
  if (existing) return existing;

  const updatedUser = await userModel.findByIdAndUpdate(
    userId,
    { $inc: { walletBalance: Number(amount) } },
    { new: true }
  );
  if (!updatedUser) throw new Error("Customer not found for wallet refund");

  const transaction = new transactionModel({
    userId,
    transactionId,
    amount: Number(amount),
    upiTransactionId: `WALLET-${transactionId}`,
    type: "refund",
    description: description || "Wallet refund",
    status: "completed",
    paymentStatus: "approved",
    paymentMethod: "wallet",
    sourceType: "wallet",
    date: new Date(),
    verificationDate: new Date(),
    orderId,
    parentTransactionId,
    referredBy: updatedUser.referredBy || null,
  });

  await transaction.save();
  return transaction;
};

// Credit a customer's wallet as an admin-initiated recharge — instant, no approval.
// The admin is a trusted actor recording money already collected (cash/UPI/bank), so unlike a
// customer's own recharge (which starts as a pending 'deposit' the admin later approves), this
// is created already 'completed'. Atomic balance credit + a 'deposit' transaction that shows up
// in the customer's wallet history exactly like any other recharge. Idempotent on transactionId.
const creditWalletInstant = async ({
  userId,
  transactionId,
  amount,
  paymentMethod = "upi",
  reference = null,
  description,
  actorId = null,
}) => {
  if (!userId) throw new Error("userId is required for wallet credit");
  if (!transactionId) throw new Error("transactionId is required");
  if (!(Number(amount) > 0)) throw new Error("A positive amount is required");

  const existing = await transactionModel.findOne({ transactionId });
  if (existing) return existing;

  const paymentEvidence = paymentMethod === "upi"
    ? await prepareUpiPaymentEvidence({ reference, transactionId, capturedVia: "admin" })
    : undefined;

  const updatedUser = await userModel.findByIdAndUpdate(
    userId,
    { $inc: { walletBalance: Number(amount) } },
    { new: true }
  );
  if (!updatedUser) throw new Error("Customer not found for wallet credit");

  const transaction = new transactionModel({
    userId,
    transactionId,
    amount: Number(amount),
    upiTransactionId: reference || `ADMIN-${transactionId}`,
    paymentEvidence,
    type: "deposit",
    description: description || "Admin wallet recharge",
    status: "completed",
    paymentStatus: "approved",
    paymentMethod,
    sourceType: "wallet",
    date: new Date(),
    verifiedBy: actorId,
    verificationDate: new Date(),
    referredBy: updatedUser.referredBy || null,
  });

  await transaction.save();
  return { transaction, newBalance: updatedUser.walletBalance };
};

module.exports = {
  createPaymentTransaction,
  deductWalletInstant,
  refundWalletInstant,
  creditWalletInstant,
};
