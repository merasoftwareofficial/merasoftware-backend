const { Resend } = require("resend");
const { generateInvoiceDocumentPdf } = require("../../helpers/generateInvoiceDocumentPdf");
const { loadInvoiceDocument } = require("./invoiceDocumentController");

const resend = new Resend(process.env.RESEND_API_KEY);

// Emailing a project statement to the customer is an admin action, so it stays here.
// Downloading and viewing one are NOT admin actions — they moved to the shared
// /invoices/:invoiceId/download|view pair in invoiceDocumentController.js, which serves the
// customer and the admin the same document. Only the send-by-email step is admin-only, and it
// builds its attachment from that same shared loader + generator so the emailed PDF can never
// differ from the downloaded one.
const requireAdmin = (req, res) => {
  if (req.userRole === "admin") return true;
  res.status(403).json({ message: "Forbidden", success: false, error: true });
  return false;
};

const resendProjectFinalInvoice = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { invoice, transactions } = await loadInvoiceDocument(req.params.invoiceId, req);
    if (!invoice.userId?.email) throw new Error("Customer email is not available");
    const pdf = await generateInvoiceDocumentPdf({ invoice, order: invoice.orderId, customer: invoice.userId, transactions });
    const result = await resend.emails.send({
      from: `${process.env.FROM_NAME || "Mera Software"} <${process.env.FROM_EMAIL}>`,
      to: [invoice.userId.email],
      subject: `Project payment summary - ${invoice.invoiceNumber}`,
      html: `<p>Hello ${invoice.userId.name || "Customer"},</p><p>Your current project payment summary is attached.</p>`,
      attachments: [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdf }],
    });
    if (result.error) throw new Error("Final invoice email could not be sent");
    return res.status(200).json({ message: "Final invoice shared by email", success: true, error: false });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message || "Failed to share final invoice", success: false, error: true });
  }
};

module.exports = { resendProjectFinalInvoice };
