const mongoose = require('mongoose');

const invoiceLineItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  paymentPolicyKey: { type: String, unique: true, sparse: true },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    required: true,
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "order",
    required: true,
  },
  invoiceNumber: {
    type: String,
    required: true,
    unique: true,
  },
  invoiceType: {
    type: String,
    // `project_final` is the one cumulative statement for a project. It is not a
    // new payment request; the normal `project` records remain the individual
    // installment/payment invoices. `complimentary_upgrade` is a ₹0 record of free
    // work on a completed project (helpers/complimentaryUpgrade.js): nothing is due
    // and no money code reads it, as every one of them selects its own types.
    enum: ["project", "project_final", "plan_renewal", "service_statement", "complimentary_upgrade"],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    enum: ["unpaid", "partially_paid", "paid", "overdue", "cancelled"],
    default: "unpaid",
  },
  // Running total of money actually applied to this invoice (wallet-instant + approved UPI parts).
  // status is derived from this (see markProjectInvoicePaid in helpers/paymentRecording.js) —
  // never hardcoded elsewhere, so an invoice's paid-state always matches money received (SSOT).
  amountPaid: {
    type: Number,
    default: 0,
  },
  invoiceDate: {
    type: Date,
    required: true,
    default: Date.now,
  },
  dueDate: {
    type: Date,
    required: true,
  },
  paidDate: {
    type: Date,
    default: null,
  },
  installmentNumber: {
    type: Number,
    default: null,
  },
  serviceCycleNumber: {
    type: Number,
    default: null,
  },
  lineItems: {
    type: [invoiceLineItemSchema],
    default: [],
  },
  paymentMethod: {
    type: String,
    enum: ["upi", "bank_transfer", "cheque", "cash", "wallet", null],
    default: null,
  },
  transactionReference: {
    type: String,
    default: null,
  },
  notes: {
    type: String,
    default: null,
  },
  internalNote: {
    type: String,
    default: null,
  },
  markedPaidBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user",
    default: null,
  },
  // The Upgrade completed message that made a complimentary_upgrade invoice: one message, one invoice.
  emailDraftId: {
    type: mongoose.Schema.Types.ObjectId,
    default: undefined,
  },
  // Written by deleteOrder.js right before the order it belongs to is hard-deleted, so this
  // invoice can still name/date/type itself in the admin "Deleted Projects" tab afterward —
  // orderId will resolve to nothing once the order is gone.
  deletedProjectName: {
    type: String,
    default: null,
  },
  deletedProjectType: {
    type: String,
    enum: ["project", "plan", null],
    default: null,
  },
  // The order's own creation date, copied here because orderId resolves to nothing once
  // the order is hard-deleted — this is "when the project was purchased".
  deletedProjectStartDate: {
    type: Date,
    default: null,
  },
  // When the delete itself happened. Previously the admin tab showed the latest payment
  // date under a "Deleted on" label, which was not the delete date at all.
  deletedProjectDeletedAt: {
    type: Date,
    default: null,
  },
  // How the project was actually paid for, derived from its completed transactions at
  // delete time — transactionModel rows are cascade-deleted, so this cannot be read later.
  // "combined" here means different payments used different methods.
  deletedProjectPaymentMethod: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

invoiceSchema.index({ userId: 1, status: 1 });
invoiceSchema.index({ orderId: 1 });
// One live cumulative invoice per project. The partial filter keeps legacy and
// installment project invoices unrestricted.
invoiceSchema.index(
  { orderId: 1, invoiceType: 1 },
  { unique: true, partialFilterExpression: { invoiceType: "project_final" } }
);
invoiceSchema.index(
  { invoiceType: 1, orderId: 1 },
  { name: "one_service_statement_per_order", unique: true, partialFilterExpression: { invoiceType: "service_statement" } }
);
invoiceSchema.index(
  { emailDraftId: 1 },
  { name: "one_invoice_per_upgrade_message", unique: true, partialFilterExpression: { emailDraftId: { $type: "objectId" } } }
);

const invoiceModel = mongoose.model("invoice", invoiceSchema);
module.exports = invoiceModel;
