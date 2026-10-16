const PDFDocument = require("pdfkit");
const { getOrderDisplayName } = require("./orderPresentation");

// SINGLE invoice-PDF generator for the whole app — customer and admin alike.
//
// What a document looks like is decided by the INVOICE'S TYPE, never by who is asking for it.
// Before this, an admin route rendered project_final one way (totals + payment history) while
// the customer route rendered the very same invoice another way (line items, no history), so
// one invoice produced two different papers depending on the viewer. The statement layout
// below is the admin one, kept as-is, now served to both.
//
// Two shapes:
//   statement (project_final / service_statement) — a summary of an order that is billed
//     elsewhere: totals, what came in, what is outstanding, and the payments behind it.
//   invoice (project / plan_renewal / anything else) — one amount actually being collected:
//     line items and the balance on this invoice alone.

const STATEMENT_TYPES = new Set(["project_final", "service_statement"]);

const money = (value) => `Rs ${Number(value || 0).toLocaleString("en-IN")}`;
const date = (value) => (value ? new Date(value).toLocaleDateString("en-IN") : "—");
const ordinal = (value) => {
  const labels = ["1st", "2nd", "3rd"];
  return labels[Number(value) - 1] || `${value}th`;
};

const isStatementInvoice = (invoice) => STATEMENT_TYPES.has(invoice?.invoiceType);

// Same wording as frontend/src/helpers/invoicePresentation.js's getInvoiceStatusText — the
// database's own words (unpaid, partially_paid, overdue) are for the system, not the reader.
const STATUS_TEXT = {
  paid: "PAID",
  partially_paid: "PART PAID",
  unpaid: "DUE",
  overdue: "OVERDUE",
  cancelled: "CANCELLED",
};
const statusText = (status) => STATUS_TEXT[status] || "DUE";

// Statement layout — carried over verbatim from the admin-only generator this replaces, so
// the document an admin has always downloaded is unchanged. Only its reach is new.
const renderStatement = (doc, { invoice, order, customer, transactions }) => {
  const total = Number(invoice.amount || 0);
  const paid = Number(invoice.amountPaid || 0);
  const balance = Math.max(0, total - paid);
  const isService = invoice.invoiceType === "service_statement";

  let y = 48;
  doc.fontSize(20).fillColor("#0f172a").text(isService ? "SERVICE BILLING STATEMENT" : "FINAL PROJECT INVOICE", 48, y);
  y += 32;
  doc.fontSize(10).fillColor("#475569").text(`Updated: ${date(invoice.updatedAt || invoice.invoiceDate)}`, 48, y);
  y += 28;
  doc.fillColor("#0f172a").fontSize(11).text(`${isService ? "Service" : "Project"}: ${getOrderDisplayName(order, isService ? "Service" : "Project")}`, 48, y);
  y += 17;
  doc.fontSize(10).fillColor("#475569").text(`Customer: ${customer?.name || "Customer"} · ${customer?.email || ""}`, 48, y);
  y += 34;
  doc.fillColor("#0f172a").fontSize(12).text(isService ? "Contracted total" : "Project total", 48, y).text(money(total), 420, y, { align: "right" });
  y += 22;
  doc.fillColor("#047857").text("Received", 48, y).text(money(paid), 420, y, { align: "right" });
  y += 22;
  doc.fillColor(balance ? "#b45309" : "#047857").text(balance ? "Outstanding" : "Balance", 48, y).text(money(balance), 420, y, { align: "right" });
  y += 38;
  doc.fillColor("#0f172a").fontSize(12).text("Payment history", 48, y);
  y += 22;

  const history = Array.isArray(transactions) ? transactions : [];
  if (!history.length) {
    doc.fontSize(10).fillColor("#64748b").text("No completed payment has been recorded yet.", 48, y);
    y += 19;
  } else {
    history.forEach((transaction) => {
      if (y > 700) { doc.addPage(); y = 48; }
      const label = transaction.installmentNumber
        ? `${ordinal(transaction.installmentNumber)} Installment · ${String(transaction.paymentMethod || "payment").toUpperCase()}`
        : `Full Payment · ${String(transaction.paymentMethod || "payment").toUpperCase()}`;
      doc.fontSize(10).fillColor("#0f172a").text(label, 48, y);
      doc.text(money(transaction.amount), 420, y, { align: "right" });
      y += 15;
      doc.fontSize(8).fillColor("#64748b").text(date(transaction.date || transaction.createdAt), 48, y);
      y += 19;
    });
  }

  y += 16;
  if (y > 700) { doc.addPage(); y = 48; }
  doc.fontSize(9).fillColor("#64748b").text(
    invoice.notes
      || (balance
        ? "This is a live payment summary. The outstanding balance remains payable."
        : "Payment complete. This document confirms the full project payment."),
    48,
    y,
    { width: 500 }
  );
};

// Invoice layout — one amount being collected. Kept from the existing customer-facing
// generator, so a plan/renewal invoice still reads exactly as it did.
const renderInvoice = (doc, { invoice, order, customer }) => {
  const paid = Number(invoice.amountPaid || 0);
  const amount = Number(invoice.amount || 0);
  const balance = Math.max(0, amount - paid);
  const items = Array.isArray(invoice.lineItems) && invoice.lineItems.length
    ? invoice.lineItems
    : [{ name: getOrderDisplayName(order, "Service"), price: amount }];

  doc.fontSize(22).fillColor("#111827").text("INVOICE", { align: "center" });
  doc.moveDown(1.4);
  doc.fontSize(10).fillColor("#374151");
  doc.text(`Issued: ${date(invoice.invoiceDate)}`);
  doc.text(`Due: ${date(invoice.dueDate)}`);
  doc.text(`Status: ${statusText(invoice.status)}`);
  if (invoice.installmentNumber) doc.text(`Installment: ${ordinal(invoice.installmentNumber)}`);
  doc.moveDown();
  doc.fontSize(12).fillColor("#111827").text("Bill To");
  doc.fontSize(10).fillColor("#374151").text(customer?.name || "Customer");
  if (customer?.email) doc.text(customer.email);
  doc.moveDown();
  doc.fontSize(12).fillColor("#111827").text(getOrderDisplayName(order, "Service"));
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#374151");
  items.forEach((item) => {
    doc.text(String(item.name || "Item"), 48, doc.y, { continued: true });
    doc.text(money(item.price), { align: "right" });
  });
  doc.moveDown();
  doc.fontSize(11).fillColor("#111827");
  doc.text(`Invoice amount: ${money(amount)}`, { align: "right" });
  doc.text(`Paid: ${money(paid)}`, { align: "right" });
  doc.text(`Balance: ${money(balance)}`, { align: "right" });
  if (invoice.notes) {
    doc.moveDown();
    doc.fontSize(9).fillColor("#4b5563").text(invoice.notes);
  }
};

const generateInvoiceDocumentPdf = ({ invoice, order, customer, transactions = [] }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (isStatementInvoice(invoice)) renderStatement(doc, { invoice, order, customer, transactions });
    else renderInvoice(doc, { invoice, order, customer });

    doc.end();
  });

module.exports = { generateInvoiceDocumentPdf, isStatementInvoice };
