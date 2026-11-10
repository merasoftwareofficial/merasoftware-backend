const { formatIndiaDate } = require('./dateTime');
const PDFDocument = require("pdfkit");
const { getOrderDisplayName } = require("./orderPresentation");

// SINGLE invoice-PDF generator for the whole app — customer and admin alike.
//
// What a document looks like is decided by the INVOICE'S TYPE, never by who is asking for it.
//
// Three shapes:
//   statement (project_final / service_statement) — the document a customer actually receives for a
//     project: what was bought, the total, what came in, what is outstanding and the payments behind it.
//   invoice (project / plan_renewal / anything else) — one amount being collected.
//   complimentary_upgrade — a ₹0 record of free work, with its own small layout below.
//
// What was bought is listed from the order's frozen agreement, never from the live catalogue:
//   · a package typed by hand: its name and the "included" lines typed when it was made;
//   · a package priced from its category and add-ons: the category, its base price and every add-on
//     with its own price (agreement.package.pricing, frozen by helpers/projectPricing.js).
// Terms and conditions are never printed here; the footer names the page that holds them.

const STATEMENT_TYPES = new Set(["project_final", "service_statement"]);

const COMPANY = {
  name: "Mera Software",
  tagline: "Digital Solutions",
  address: "VA Computers, Near New Bus Stand, Majitha 143601",
  contact: "contact@merasoftware.com  ·  +91 92565 37003",
  website: "www.merasoftware.com",
  websiteUrl: "https://www.merasoftware.com",
  terms: "www.merasoftware.com/terms",
  termsUrl: "https://www.merasoftware.com/terms",
};

const COLOR = { accent: "#0b5f66", ink: "#17212b", muted: "#4a5763", rule: "#d9dee3", tint: "#f3f6f8", ok: "#0b6b3a", due: "#a15c00" };
const LEFT = 48;
const RIGHT = 547;
const WIDTH = RIGHT - LEFT;
const AMOUNT_W = 110;
const DESC_W = WIDTH - AMOUNT_W - 16;
const PAGE_BOTTOM = 752; // the footer owns everything below this

// A negative amount is a discount line (helpers/paymentRecording.js buildLineItemsFromOrder).
const money = (value) => {
  const amount = Number(value || 0);
  return `${amount < 0 ? "- " : ""}Rs ${Math.abs(amount).toLocaleString("en-IN")}`;
};
// A ₹0 project (100% discount / offer) reads FREE wherever its total is printed.
const totalText = (value) => (Number(value || 0) === 0 ? "FREE" : money(value));
const date = (value) => (value ? formatIndiaDate(value) : "—");
const ordinal = (value) => {
  const labels = ["1st", "2nd", "3rd"];
  return labels[Number(value) - 1] || `${value}th`;
};
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

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
const statusColor = (status) => (status === "paid" ? COLOR.ok : status === "cancelled" ? COLOR.muted : COLOR.due);

const humanize = (key) => String(key || "").split("_").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");

// ---------------------------------------------------------------------------------------------
// What the invoice lists. Pure: the rows are decided here and drawn below, so the content can be
// tested without a PDF.
//   row: { name, detail?, bullets?, price }   or a group heading { group: true, name, detail? }
// ---------------------------------------------------------------------------------------------
const agreementRows = (order) => {
  const agreement = order?.projectSnapshot?.salesAgreement;
  if (!agreement || ![1, 2].includes(agreement.version)) return null;
  const rows = [];
  const pkg = agreement.package;
  const title = pkg?.name || agreement.offer?.title || "Project scope";
  const pricing = pkg?.pricing;
  if (pricing && Array.isArray(pricing.services)) {
    const category = order.projectSnapshot.categoryLabel || humanize(pkg.category);
    rows.push({ group: true, name: title, detail: category });
    rows.push({ name: `${category || "Category"} base price`, price: Number(pricing.categoryBasePrice) });
    for (const service of pricing.services) {
      const quantity = service.isQuantityBased ? Number(service.quantity) || 1 : 1;
      rows.push({ name: service.name, detail: quantity > 1 ? `${quantity} x ${money(service.unitPrice)}` : "", price: round2(Number(service.unitPrice) * quantity) });
    }
    const parts = rows.reduce((sum, row) => sum + (row.price || 0), 0);
    const difference = round2(Number(agreement.regularPrice) - parts);
    // The package's normal price can differ from the sum of its parts (a typed discount); the table still adds up.
    if (difference) rows.push({ name: difference < 0 ? "Package discount" : "Package price adjustment", price: difference });
  } else {
    rows.push({ name: title, bullets: (agreement.scope || []).filter((line) => String(line).trim()), price: Number(agreement.regularPrice) });
  }
  if (agreement.offerDiscount > 0) rows.push({ name: `Offer benefit (${agreement.offer?.title || "Offer"})`, price: -Number(agreement.offerDiscount) });
  for (const extra of agreement.extras || []) {
    rows.push({ name: extra.name, detail: extra.quantity > 1 ? `${extra.quantity} x ${money(extra.unitPrice)}` : "", price: Number(extra.price) });
  }
  if (agreement.adminDiscount > 0) rows.push({ name: `Additional discount: ${agreement.discountReason}`, price: -Number(agreement.adminDiscount) });
  if (agreement.priceAdjustment) rows.push({ name: agreement.adjustmentLabel, price: Number(agreement.priceAdjustment) });
  return rows;
};

const buildInvoiceRows = ({ invoice, order, targetTotal }) => {
  const rows = agreementRows(order);
  if (rows) {
    // Whatever the agreement lines add up to, the table ends at the amount the customer owes.
    const sum = round2(rows.reduce((total, row) => total + (row.price || 0), 0));
    const target = Number(targetTotal);
    if (Number.isFinite(target) && round2(target - sum) !== 0) rows.push({ name: "Agreed price adjustment", price: round2(target - sum) });
    return rows;
  }
  const items = Array.isArray(invoice.lineItems) && invoice.lineItems.length
    ? invoice.lineItems
    : [{ name: getOrderDisplayName(order, "Service"), price: invoice.amount }];
  return items.map((item) => ({ name: String(item.name || "Item"), price: Number(item.price) }));
};

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------
const drawHeader = (doc, title, number) => {
  doc.roundedRect(LEFT, 48, 34, 34, 6).fill(COLOR.accent);
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#ffffff").text("M", LEFT, 57, { width: 34, align: "center", lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(14).fillColor(COLOR.ink).text(COMPANY.name, LEFT + 44, 48, { lineBreak: false });
  doc.font("Helvetica").fontSize(8.5).fillColor(COLOR.muted);
  doc.text(COMPANY.tagline, LEFT + 44, 65, { lineBreak: false });
  doc.text(COMPANY.address, LEFT + 44, 76, { lineBreak: false });
  doc.text(COMPANY.contact, LEFT + 44, 87, { lineBreak: false });
  doc.font("Helvetica-Bold").fontSize(title.length > 14 ? 15 : 20).fillColor(COLOR.accent).text(title, LEFT + 260, 50, { width: WIDTH - 260, align: "right", lineBreak: false });
  if (number) doc.font("Helvetica").fontSize(10).fillColor(COLOR.muted).text(number, LEFT + 260, 76, { width: WIDTH - 260, align: "right", lineBreak: false });
  doc.moveTo(LEFT, 106).lineTo(RIGHT, 106).lineWidth(2).strokeColor(COLOR.accent).stroke();
  return 124;
};

const label = (doc, text, x, y) => doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLOR.muted).text(String(text).toUpperCase(), x, y, { lineBreak: false, characterSpacing: 0.8 });

// Bill to (left) and the dates and status (right). Returns the y below the taller side.
const drawMeta = (doc, y, { customer, project, pairs }) => {
  label(doc, "Bill to", LEFT, y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOR.ink).text(customer?.name || "Customer", LEFT, y + 13, { width: 270, lineBreak: false });
  let left = y + 29;
  doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.muted);
  if (customer?.email) { doc.text(customer.email, LEFT, left, { width: 270, lineBreak: false }); left += 14; }
  if (project) {
    left += 6;
    label(doc, "Project", LEFT, left);
    doc.font("Helvetica").fontSize(10).fillColor(COLOR.ink).text(project, LEFT, left + 12, { width: 270, lineBreak: false });
    left += 28;
  }
  let right = y;
  for (const pair of pairs) {
    doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.muted).text(pair.label, 340, right, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(pair.color || COLOR.ink).text(pair.value, 340, right, { width: RIGHT - 340, align: "right", lineBreak: false });
    right += 17;
  }
  return Math.max(left, right) + 14;
};

const ensure = (doc, y, need) => {
  if (y + need <= PAGE_BOTTOM) return y;
  doc.addPage();
  return 48;
};

const tableHead = (doc, y, left, right) => {
  doc.rect(LEFT, y, WIDTH, 22).fill(COLOR.tint);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLOR.muted);
  doc.text(left.toUpperCase(), LEFT + 8, y + 7, { lineBreak: false, characterSpacing: 0.8 });
  doc.text(right.toUpperCase(), RIGHT - AMOUNT_W - 8, y + 7, { width: AMOUNT_W, align: "right", lineBreak: false, characterSpacing: 0.8 });
  doc.moveTo(LEFT, y + 22).lineTo(RIGHT, y + 22).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
  return y + 22;
};

const rule = (doc, y) => doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(COLOR.rule).stroke();

const drawRows = (doc, startY, rows) => {
  let y = ensure(doc, startY, 60);
  y = tableHead(doc, y, "Description", "Amount");
  for (const row of rows) {
    const bold = row.group || row.bullets;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
    const nameHeight = doc.heightOfString(row.name, { width: DESC_W });
    const detailHeight = row.detail ? 12 : 0;
    const firstBullet = row.bullets?.length ? 14 : 0;
    y = ensure(doc, y, nameHeight + detailHeight + firstBullet + 14);
    const top = y + 8;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(row.price < 0 ? COLOR.ok : COLOR.ink).text(row.name, LEFT + 8, top, { width: DESC_W });
    if (row.price !== undefined) doc.font("Helvetica").fontSize(10).fillColor(row.price < 0 ? COLOR.ok : COLOR.ink).text(money(row.price), RIGHT - AMOUNT_W - 8, top, { width: AMOUNT_W, align: "right", lineBreak: false });
    y = top + nameHeight;
    if (row.detail) { doc.font("Helvetica").fontSize(8.5).fillColor(COLOR.muted).text(row.detail, LEFT + 8, y + 1, { width: DESC_W, lineBreak: false }); y += detailHeight; }
    for (const bullet of row.bullets || []) {
      doc.font("Helvetica").fontSize(9);
      const height = doc.heightOfString(bullet, { width: DESC_W - 16 });
      y = ensure(doc, y, height + 4);
      doc.fillColor(COLOR.muted).text("-", LEFT + 12, y + 3, { lineBreak: false });
      doc.text(bullet, LEFT + 24, y + 3, { width: DESC_W - 16 });
      y += height + 3;
    }
    y += 8;
    rule(doc, y);
  }
  return y;
};

// Right-hand totals block: [{ label, value, strong?, color?, line? }]
const drawTotals = (doc, startY, lines) => {
  let y = ensure(doc, startY + 14, lines.length * 22 + 10);
  for (const line of lines) {
    if (line.line) { doc.moveTo(330, y).lineTo(RIGHT, y).lineWidth(1.5).strokeColor(COLOR.ink).stroke(); y += 6; }
    doc.font(line.strong ? "Helvetica-Bold" : "Helvetica").fontSize(line.strong ? 12 : 10).fillColor(line.color || COLOR.ink);
    doc.text(line.label, 338, y, { lineBreak: false });
    doc.text(line.value, 338, y, { width: RIGHT - 338 - 8, align: "right", lineBreak: false });
    y += line.strong ? 24 : 19;
  }
  return y;
};

const drawFooters = (doc) => {
  const { start, count } = doc.bufferedPageRange();
  for (let index = 0; index < count; index += 1) {
    doc.switchToPage(start + index);
    // Text below the bottom margin would start a new page; the footer sits there on purpose.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(LEFT, 772).lineTo(RIGHT, 772).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
    doc.font("Helvetica").fontSize(9).fillColor(COLOR.muted);
    doc.text(`Package details: ${COMPANY.website}`, LEFT, 780, { width: WIDTH, align: "center", lineBreak: false, link: COMPANY.websiteUrl });
    doc.text(`Terms & Conditions: ${COMPANY.terms}`, LEFT, 793, { width: WIDTH, align: "center", lineBreak: false, link: COMPANY.termsUrl });
    doc.fontSize(8).text(`This is a computer-generated invoice.  ·  Page ${index + 1} of ${count}`, LEFT, 808, { width: WIDTH, align: "center", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
};

// Statement layout — the project's whole story: what was bought, the total, what is paid and owed, and each payment.
const renderStatement = (doc, { invoice, order, customer, transactions }) => {
  const total = Number(invoice.amount || 0);
  const paid = Number(invoice.amountPaid || 0);
  const balance = Math.max(0, total - paid);
  const isService = invoice.invoiceType === "service_statement";

  let y = drawHeader(doc, isService ? "SERVICE STATEMENT" : "FINAL PROJECT INVOICE", invoice.invoiceNumber);
  y = drawMeta(doc, y, {
    customer,
    project: getOrderDisplayName(order, isService ? "Service" : "Project"),
    pairs: [
      { label: "Issued", value: date(invoice.invoiceDate) },
      { label: "Status", value: statusText(invoice.status), color: statusColor(invoice.status) },
    ],
  });
  y = drawRows(doc, y, buildInvoiceRows({ invoice, order, targetTotal: total }));
  y = drawTotals(doc, y, [
    { label: isService ? "Contracted total" : "Project total", value: totalText(total), strong: true, line: true },
    { label: "Received", value: money(paid), color: COLOR.ok },
    { label: balance ? "Outstanding" : "Balance", value: money(balance), color: balance ? COLOR.due : COLOR.ok },
  ]);

  y = ensure(doc, y + 20, 70);
  y = tableHead(doc, y, "Payment history", "Amount");
  const history = Array.isArray(transactions) ? transactions : [];
  if (!history.length) {
    doc.font("Helvetica").fontSize(9.5).fillColor(COLOR.muted).text(total === 0 ? "No payment is due — this project is free." : "No completed payment has been recorded yet.", LEFT + 8, y + 9, { width: WIDTH - 16 });
    return;
  }
  for (const transaction of history) {
    y = ensure(doc, y, 36);
    const text = transaction.installmentNumber
      ? `${ordinal(transaction.installmentNumber)} Installment · ${String(transaction.paymentMethod || "payment").toUpperCase()}`
      : `Full Payment · ${String(transaction.paymentMethod || "payment").toUpperCase()}`;
    doc.font("Helvetica").fontSize(10).fillColor(COLOR.ink).text(text, LEFT + 8, y + 8, { width: DESC_W, lineBreak: false });
    doc.text(money(transaction.amount), RIGHT - AMOUNT_W - 8, y + 8, { width: AMOUNT_W, align: "right", lineBreak: false });
    doc.font("Helvetica").fontSize(8.5).fillColor(COLOR.muted).text(date(transaction.date || transaction.createdAt), LEFT + 8, y + 21, { lineBreak: false });
    y += 34;
    rule(doc, y);
  }
};

// Invoice layout — one amount being collected.
const renderInvoice = (doc, { invoice, order, customer }) => {
  const paid = Number(invoice.amountPaid || 0);
  const amount = Number(invoice.amount || 0);
  const balance = Math.max(0, amount - paid);
  const orderTotal = Number(order?.totalAmount);

  let y = drawHeader(doc, "INVOICE", invoice.invoiceNumber);
  y = drawMeta(doc, y, {
    customer,
    project: getOrderDisplayName(order, "Service"),
    pairs: [
      { label: "Issued", value: date(invoice.invoiceDate) },
      { label: "Due", value: date(invoice.dueDate) },
      { label: "Status", value: statusText(invoice.status), color: statusColor(invoice.status) },
      ...(invoice.installmentNumber ? [{ label: "Installment", value: ordinal(invoice.installmentNumber) }] : []),
    ],
  });
  const rows = buildInvoiceRows({ invoice, order, targetTotal: invoice.installmentNumber && Number.isFinite(orderTotal) ? orderTotal : amount });
  y = drawRows(doc, y, rows);
  const rowsTotal = round2(rows.reduce((sum, row) => sum + (row.price || 0), 0));
  const lines = [];
  // An installment invoice lists the whole project but collects only its own part.
  const partial = round2(rowsTotal - amount) !== 0;
  if (partial) lines.push({ label: "Project total", value: totalText(rowsTotal), line: true });
  lines.push({ label: invoice.installmentNumber ? `${ordinal(invoice.installmentNumber)} installment` : "Invoice total", value: totalText(amount), strong: true, line: !partial });
  lines.push({ label: "Paid", value: money(paid), color: COLOR.ok });
  lines.push({ label: "Balance due", value: money(balance), color: balance ? COLOR.due : COLOR.ok });
  y = drawTotals(doc, y, lines);
  if (invoice.notes) {
    y = ensure(doc, y + 14, 30);
    doc.font("Helvetica").fontSize(9).fillColor(COLOR.muted).text(invoice.notes, LEFT, y + 10, { width: WIDTH });
  }
};

const isComplimentaryInvoice = (invoice) => invoice?.invoiceType === "complimentary_upgrade";

// Complimentary layout — a ₹0 record of free work (helpers/complimentaryUpgrade.js). Nothing was
// ever due, so it has no due date, no paid/balance lines and none of the project's payment terms.
const renderComplimentary = (doc, { invoice, order, customer }) => {
  doc.fontSize(22).fillColor("#111827").text("COMPLIMENTARY INVOICE", { align: "center" });
  doc.moveDown(1.4);
  doc.fontSize(10).fillColor("#374151");
  doc.text(`Invoice number: ${invoice.invoiceNumber}`);
  doc.text(`Issued: ${date(invoice.invoiceDate)}`);
  doc.text("Payment: No payment due");
  doc.moveDown();
  doc.fontSize(12).fillColor("#111827").text("Issued To");
  doc.fontSize(10).fillColor("#374151").text(customer?.name || "Customer");
  if (customer?.email) doc.text(customer.email);
  doc.moveDown();
  doc.fontSize(12).fillColor("#111827").text(getOrderDisplayName(order, "Project"));
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#374151");
  (invoice.lineItems || []).forEach((item) => {
    doc.text(String(item.name || "Complimentary upgrade"), 48, doc.y, { continued: true });
    doc.text(money(item.price), { align: "right" });
  });
  doc.moveDown();
  doc.fontSize(11).fillColor("#111827").text(`Total: ${money(invoice.amount)} (FREE)`, { align: "right" });
  if (invoice.notes) {
    doc.moveDown();
    doc.fontSize(9).fillColor("#4b5563").text(invoice.notes);
  }
};

const generateInvoiceDocumentPdf = ({ invoice, order, customer, transactions = [] }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4", bufferPages: true });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      if (isComplimentaryInvoice(invoice)) {
        renderComplimentary(doc, { invoice, order, customer });
        doc.end();
        return;
      }
      if (isStatementInvoice(invoice)) renderStatement(doc, { invoice, order, customer, transactions });
      else renderInvoice(doc, { invoice, order, customer });
      drawFooters(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });

module.exports = { generateInvoiceDocumentPdf, isStatementInvoice, isComplimentaryInvoice, buildInvoiceRows };
