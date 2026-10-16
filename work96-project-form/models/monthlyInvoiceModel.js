const mongoose = require("mongoose");

const monthlyInvoiceSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "order",
            required: true
        },
        invoiceNumber: {
            type: String,
            required: true,
            unique: true
        },
        amount: {
            type: Number,
            required: true
        },
        status: {
            type: String,
            enum: ["unpaid", "paid", "overdue", "cancelled"],
            default: "unpaid"
        },
        invoiceDate: {
            type: Date,
            required: true,
            default: Date.now
        },
        dueDate: {
            type: Date,
            required: true
        },
        paidDate: {
            type: Date,
            default: null
        },
        renewalMonth: {
            type: Number, // Which renewal number (1-12)
            required: true
        },
        renewalPeriodStart: {
            type: Date,
            required: true
        },
        renewalPeriodEnd: {
            type: Date,
            required: true
        },
        pdfUrl: {
            type: String,
            default: null
        },
        paymentMethod: {
            type: String,
            enum: ["upi", "bank_transfer", "cash", "wallet", null],
            default: null
        },
        transactionReference: {
            type: String, // UPI transaction ID or bank reference
            default: null
        },
        notes: {
            type: String,
            default: null
        },
        remindersSent: {
            type: Number,
            default: 0 // Count of reminder emails sent
        },
        lastReminderDate: {
            type: Date,
            default: null
        },
        markedPaidBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            default: null // Admin who marked it as paid
        },
        internalNote: {
            type: String,
            default: null // Admin-only comment, never shown to the customer
        }
    },
    { timestamps: true }
);

// Index for faster queries
monthlyInvoiceSchema.index({ userId: 1, status: 1 });
monthlyInvoiceSchema.index({ orderId: 1 });
monthlyInvoiceSchema.index({ dueDate: 1, status: 1 });

const monthlyInvoiceModel = mongoose.model('monthlyInvoice', monthlyInvoiceSchema);
module.exports = monthlyInvoiceModel;
