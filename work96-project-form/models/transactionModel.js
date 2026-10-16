const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true
        },
        transactionId: {
            type: String,
            required: true,
            unique: true
        },
        upiTransactionId: { // Add this field
            type: String,
            default: null
          },
        amount: {
            type: Number,
            required: true
        },
        status: {
            type: String,
            enum: ["pending", "completed", "failed", "refunded", "rejected"],
            default: "pending"
        },
        paymentStatus: {
            type: String,
            enum: ["pending-approval", "approved", "rejected"],
            default: null
        },
        type: {
            type: String,
            enum: ["deposit", "payment", "refund", "renewal"],
            required: true
        },
        sourceType: {
            type: String,
            enum: ["wallet", "order", "installment", "invoice", "renewal"],
            default: null
        },
        description: {
            type: String,
            required: true
        },
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "product"
        },
        quantity: {
            type: Number
        },
        paymentMethod: {
            type: String,
            // "demo" is additive: guest dummy-wallet-credit only, never real money.
            // "reward" is additive: automatic system-credited rewards (e.g. lead
            // reference), never a manually recorded payment method.
            enum: ["wallet", "upi", "combined", "cash", "bank_transfer", "demo", "reward"],
            default: "upi"
        },
         // Add parentTransactionId for combined payments
        parentTransactionId: {
            type: String,
            default: null
        },
        paymentDetails: {
            type: Object
        },
        // Canonical evidence for new external payments. The legacy upiTransactionId field is
        // retained because old wallet/admin records used it for non-UPI identifiers too.
        paymentEvidence: {
            upiReference: { type: String, default: null },
            upiReferenceKey: { type: String, default: null },
            capturedVia: { type: String, enum: ["customer", "admin", null], default: null },
            capturedAt: { type: Date, default: null },
        },
        verifiedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user"
        },
        verificationDate: {
            type: Date,
            default: null
        },
        date: {
            type: Date,
            default: Date.now
        },
        isInstallmentPayment: {
            type: Boolean,
            default: false
        },
        installmentNumber: {
            type: Number
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "order"
        },
        invoiceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "monthlyInvoice",
            default: null
        },
        referredBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user"
        },
        partnerWalletCredited: {
            type: Boolean,
            default: false
        },
        // Renewal-specific fields
        renewalNumber: {
            type: Number,
            default: null
        },
        renewalPeriodStart: {
            type: Date,
            default: null
        },
        renewalPeriodEnd: {
            type: Date,
            default: null
        },
        isPartialInstallmentPayment: {
            type: Boolean,
            default: false
        },
        rejectionReason: {
            type: String,
            default: null
        },
        rejectedAt: {
            type: Date,
            default: null
        },
        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            default: null
        },
        // Written by deleteOrder.js right before the order is removed. Transactions are KEPT on
        // delete (they are the only record that real money moved, including a cancellation's
        // refund), but orderId then points at nothing — so the payment can still name itself.
        // Same two fields, same purpose, as invoiceModel's deletedProject* snapshot.
        deletedProjectName: {
            type: String,
            default: null
        },
        deletedProjectType: {
            type: String,
            enum: ["project", "plan", null],
            default: null
        }
    },
    { timestamps: true }
);

transactionSchema.index({ invoiceId: 1 });
transactionSchema.index({ orderId: 1 });
transactionSchema.index({ userId: 1, status: 1 });
transactionSchema.index({ sourceType: 1, status: 1 });
// Parent-child payments: one UPI payment can cover several service-plan orders. Approving
// or rejecting the parent resolves its children, so the children must be findable by parent.
transactionSchema.index({ parentTransactionId: 1 });
transactionSchema.index(
    { "paymentEvidence.upiReferenceKey": 1 },
    {
        unique: true,
        partialFilterExpression: {
            paymentMethod: "upi",
            "paymentEvidence.upiReferenceKey": { $exists: true, $type: "string" },
        },
    }
);

const transactionModel = mongoose.model('transaction', transactionSchema);
module.exports = transactionModel;
