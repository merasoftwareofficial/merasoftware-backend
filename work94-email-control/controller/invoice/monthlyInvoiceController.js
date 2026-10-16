const {
  updateOverdueInvoicesAndPausePlans,
  markInvoicePaidAndResumePlan,
} = require("../../helpers/invoiceLifecycle");
const transactionModel = require("../../models/transactionModel");
const monthlyInvoiceModel = require("../../models/monthlyInvoiceModel");
const {
  generateMonthlyInvoicePdf,
  sendMonthlyInvoiceEmail,
} = require("../../helpers/emailService");
const mongoose = require("mongoose");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const requireAdmin = (req, res) => {
  if (req.userRole !== "admin") {
    res.status(403).json({
      message: "Forbidden",
      error: true,
      success: false,
    });
    return false;
  }

  return true;
};

const updateOverdueInvoices = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const result = await updateOverdueInvoicesAndPausePlans();

    return res.status(200).json({
      message: "Overdue invoices updated successfully",
      success: true,
      error: false,
      data: result,
    });
  } catch (error) {
    console.error("Error updating overdue invoices:", error);
    return res.status(500).json({
      message: error.message || "Failed to update overdue invoices",
      success: false,
      error: true,
    });
  }
};

const markInvoiceAsPaid = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { invoiceId } = req.params;
    const { paymentMethod, transactionReference, internalNote } = req.body || {};

    const result = await markInvoicePaidAndResumePlan({
      invoiceId,
      paymentMethod,
      transactionReference,
      markedPaidBy: req.userId,
      internalNote: typeof internalNote === "string" ? internalNote.trim() : internalNote,
    });

    return res.status(200).json({
      message: result.planResumed
        ? "Invoice marked as paid and plan resumed"
        : "Invoice marked as paid",
      success: true,
      error: false,
      data: {
        invoice: result.invoice,
        transaction: result.transaction,
        order: result.order,
        planResumed: result.planResumed,
      },
    });
  } catch (error) {
    console.error("Error marking invoice as paid:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to mark invoice as paid",
      success: false,
      error: true,
    });
  }
};

const findPaymentRecord = async ({ customerId, recordType, recordId }) => {
  if (!mongoose.Types.ObjectId.isValid(customerId) || !mongoose.Types.ObjectId.isValid(recordId)) {
    const error = new Error("Valid customerId and recordId are required");
    error.statusCode = 400;
    throw error;
  }

  if (recordType === "transaction") {
    const transaction = await transactionModel
      .findOne({ _id: recordId, userId: customerId })
      .populate("userId", "name email walletBalance")
      .populate("productId", "serviceName category")
      .populate("verifiedBy", "name email")
      .populate("rejectedBy", "name email")
      .populate({
        path: "orderId",
        select: "productId totalPrice price status projectProgress",
        populate: { path: "productId", select: "serviceName category" },
      })
      .populate({
        path: "invoiceId",
        populate: [
          { path: "userId", select: "name email walletBalance" },
          {
            path: "orderId",
            select: "productId totalPrice price status projectProgress",
            populate: { path: "productId", select: "serviceName category" },
          },
          { path: "markedPaidBy", select: "name email" },
        ],
      });

    return {
      recordType,
      transaction,
      invoice: transaction?.invoiceId || null,
    };
  }

  if (recordType === "invoice") {
    const invoice = await monthlyInvoiceModel
      .findOne({ _id: recordId, userId: customerId })
      .populate("userId", "name email walletBalance")
      .populate({
        path: "orderId",
        select: "productId totalPrice price status projectProgress",
        populate: { path: "productId", select: "serviceName category" },
      })
      .populate("markedPaidBy", "name email");

    const transaction = invoice
      ? await transactionModel
          .findOne({ invoiceId: invoice._id, userId: customerId })
          .populate("userId", "name email walletBalance")
          .populate("productId", "serviceName category")
          .populate("verifiedBy", "name email")
          .populate("rejectedBy", "name email")
          .populate({
            path: "orderId",
            select: "productId totalPrice price status projectProgress",
            populate: { path: "productId", select: "serviceName category" },
          })
      : null;

    return {
      recordType,
      transaction,
      invoice,
    };
  }

  const error = new Error("Invalid payment record type");
  error.statusCode = 400;
  throw error;
};

const getPaymentRecordDetail = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { customerId, recordType, recordId } = req.params;
    const record = await findPaymentRecord({ customerId, recordType, recordId });

    if (!record.transaction && !record.invoice) {
      return res.status(404).json({
        message: "Payment record not found",
        success: false,
        error: true,
      });
    }

    return res.status(200).json({
      message: "Payment record fetched successfully",
      success: true,
      error: false,
      data: record,
    });
  } catch (error) {
    console.error("Error fetching payment record detail:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to fetch payment record",
      success: false,
      error: true,
    });
  }
};

const resolveInvoiceForAction = async ({ customerId, recordType, recordId }) => {
  const record = await findPaymentRecord({ customerId, recordType, recordId });
  const invoice = record.invoice;

  if (!invoice) {
    const error = new Error("This payment record does not have a linked invoice");
    error.statusCode = 400;
    throw error;
  }

  return { ...record, invoice };
};

const downloadPaymentRecordInvoice = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { customerId, recordType, recordId } = req.params;
    const { invoice } = await resolveInvoiceForAction({ customerId, recordType, recordId });
    const invoicePdf = await generateMonthlyInvoicePdf(invoice.userId, invoice.orderId, invoice);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Invoice-${invoice.invoiceNumber || invoice._id}.pdf`
    );
    return res.send(invoicePdf);
  } catch (error) {
    console.error("Error downloading payment record invoice:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to download invoice",
      success: false,
      error: true,
    });
  }
};

const resendPaymentRecordInvoice = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { customerId, recordType, recordId } = req.params;
    const { invoice } = await resolveInvoiceForAction({ customerId, recordType, recordId });
    const invoicePdf = await generateMonthlyInvoicePdf(invoice.userId, invoice.orderId, invoice);
    const sent = await sendMonthlyInvoiceEmail(invoice.userId, invoice.orderId, invoice, invoicePdf);

    if (!sent) {
      throw new Error("Invoice email could not be sent");
    }

    return res.status(200).json({
      message: "Invoice email resent successfully",
      success: true,
      error: false,
      data: { invoice },
    });
  } catch (error) {
    console.error("Error resending payment record invoice:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to resend invoice email",
      success: false,
      error: true,
    });
  }
};

const reminderTemplates = {
  gentle: "This is a friendly reminder that your invoice payment is still pending. Please clear the payment at your earliest convenience.",
  overdue: "Your invoice is overdue. Please clear the pending payment to avoid interruption in service processing.",
  final: "This is a final reminder for your pending invoice payment. Please complete the payment as soon as possible.",
};

const sendPaymentRecordReminder = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { customerId, recordType, recordId } = req.params;
    const { template = "gentle", message = "" } = req.body || {};
    const { invoice } = await resolveInvoiceForAction({ customerId, recordType, recordId });

    if (!["unpaid", "overdue"].includes(invoice.status)) {
      return res.status(400).json({
        message: "Reminder can only be sent for pending invoices",
        success: false,
        error: true,
      });
    }

    const reminderMessage = String(message || reminderTemplates[template] || reminderTemplates.gentle).trim();
    const user = invoice.userId;
    const order = invoice.orderId;

    if (!user?.email) {
      return res.status(400).json({
        message: "Customer email is not available",
        success: false,
        error: true,
      });
    }

    const invoicePdf = await generateMonthlyInvoicePdf(user, order, invoice);
    const { error } = await resend.emails.send({
      from: `${process.env.FROM_NAME || "Mera Software"} <${process.env.FROM_EMAIL}>`,
      to: [user.email],
      subject: `Payment reminder - Invoice #${invoice.invoiceNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Payment Reminder</h2>
          <p>Hello ${user.name || "Customer"},</p>
          <p>${reminderMessage}</p>
          <p><strong>Invoice:</strong> ${invoice.invoiceNumber}</p>
          <p><strong>Amount Due:</strong> Rs ${Number(invoice.amount || 0).toLocaleString("en-IN")}</p>
          <p><strong>Due Date:</strong> ${new Date(invoice.dueDate).toLocaleDateString("en-IN")}</p>
          <p>Invoice PDF is attached for your reference.</p>
          <p>Regards,<br>Mera Software Team</p>
        </div>
      `,
      attachments: [
        {
          filename: `Invoice-${invoice.invoiceNumber}.pdf`,
          content: invoicePdf,
        },
      ],
    });

    if (error) {
      console.error("Error sending payment reminder email:", error);
      throw new Error("Payment reminder could not be sent");
    }

    invoice.remindersSent = Number(invoice.remindersSent || 0) + 1;
    invoice.lastReminderDate = new Date();
    await invoice.save();

    return res.status(200).json({
      message: "Payment reminder sent successfully",
      success: true,
      error: false,
      data: { invoice },
    });
  } catch (error) {
    console.error("Error sending payment record reminder:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to send payment reminder",
      success: false,
      error: true,
    });
  }
};

module.exports = {
  updateOverdueInvoices,
  markInvoiceAsPaid,
  getPaymentRecordDetail,
  downloadPaymentRecordInvoice,
  resendPaymentRecordInvoice,
  sendPaymentRecordReminder,
};
