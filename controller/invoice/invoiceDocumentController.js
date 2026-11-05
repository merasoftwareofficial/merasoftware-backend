const invoiceModel = require("../../models/invoiceModel");
const monthlyInvoiceModel = require("../../models/monthlyInvoiceModel");
const transactionModel = require("../../models/transactionModel");
const { generateInvoiceDocumentPdf, isStatementInvoice, isComplimentaryInvoice } = require("../../helpers/generateInvoiceDocumentPdf");

// SINGLE load path for any invoice document — the one place that answers "may this person see
// this invoice, and what goes into its PDF." Both the customer's own download and the admin's
// go through here, so neither can drift from the other.
//
// The order is populated WITHOUT a select so every naming source getOrderDisplayName() reads
// (projectSnapshot / productId / servicePlanSnapshot) is present. A narrowed select here would
// silently blank the project name on some orders.
const INVOICE_POPULATE = [
  { path: "userId", select: "name email" },
  { path: "orderId", populate: { path: "productId", select: "serviceName category" } },
];

// A statement summarises an order that is billed elsewhere, so it must show the payments behind
// it. Renewals count: a plan/service order collects through renewal transactions, and leaving
// them out would understate what the customer actually paid.
const loadStatementTransactions = async (invoice) => {
  const orderId = invoice?.orderId?._id || invoice?.orderId;
  if (!orderId) return [];
  return transactionModel.find({
    orderId,
    type: { $in: ["payment", "renewal"] },
    status: "completed",
  }).sort({ date: 1, createdAt: 1 }).lean();
};

const loadInvoiceDocument = async (invoiceId, req) => {
  const invoice = await invoiceModel.findById(invoiceId).populate(INVOICE_POPULATE)
    || await monthlyInvoiceModel.findById(invoiceId).populate(INVOICE_POPULATE);
  if (!invoice) {
    const error = new Error("Invoice not found");
    error.statusCode = 404;
    throw error;
  }
  // An admin may open any invoice; anyone else only their own.
  if (req.userRole !== "admin" && String(invoice.userId?._id || invoice.userId) !== String(req.userId)) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
  const transactions = isStatementInvoice(invoice) ? await loadStatementTransactions(invoice) : [];
  return { invoice, transactions };
};

const sendInvoiceDocument = (disposition) => async (req, res) => {
  try {
    const { invoice, transactions } = await loadInvoiceDocument(req.params.invoiceId, req);
    const pdf = await generateInvoiceDocumentPdf({ invoice, order: invoice.orderId, customer: invoice.userId, transactions });
    res.setHeader("Content-Type", "application/pdf");
    const fileName = `${isComplimentaryInvoice(invoice) ? "Complimentary-Invoice" : "Invoice"}-${invoice.invoiceNumber || invoice._id}`;
    res.setHeader("Content-Disposition", `${disposition}; filename=${fileName}.pdf`);
    return res.send(pdf);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Unable to prepare invoice document", success: false, error: true });
  }
};

module.exports = {
  viewInvoiceDocument: sendInvoiceDocument("inline"),
  downloadInvoiceDocument: sendInvoiceDocument("attachment"),
  loadInvoiceDocument,
};
