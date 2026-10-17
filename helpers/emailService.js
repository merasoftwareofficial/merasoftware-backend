const { formatIndiaDate, formatIndiaDateTime } = require('./dateTime');
const { reviewTransport: resend, withEvent, queueMail } = require('./emailController');
const { getOrderDisplayName } = require('./orderPresentation');
const { buildTemplatedMail } = require('./emailTemplates');

// Every mail builder only hands its data to the action's template (helpers/emailDefinitions.js);
// the wording lives in the editable template, and the builder prepares a review draft — it
// cannot send mail.

/**
 * Prepares the review draft of an action's mail for a caller that is not a builder below
 * (a controller calling queueMail itself). Returns queueMail's result; no recipient = suppressed.
 */
const prepareTemplatedMail = async (event, ...args) => {
  const mail = buildTemplatedMail(event, ...args);
  return mail ? queueMail(event, mail) : { data: null, error: null, suppressed: true };
};

/** Prepares a builder's review draft; true when a draft is waiting for review. */
const sendTemplatedEmail = async (event, ...args) => {
  try {
    const mail = buildTemplatedMail(event, ...args);
    if (!mail) {
      console.warn(`No recipient email for ${event}`);
      return false;
    }
    const { error, queued, suppressed } = await resend.emails.send(mail);
    if (suppressed) return false;
    if (queued) return true;
    if (error) console.error(`Error preparing ${event} email:`, error);
    return false;
  } catch (error) {
    console.error(`Error preparing ${event} email:`, error);
    return false;
  }
};

/** Admins: a customer submitted an update request. */
const sendUpdateRequestNotification = (updateRequest, adminEmails) =>
  sendTemplatedEmail('sendUpdateRequestNotification', updateRequest, adminEmails);

/** Customer: their update request was received. */
const sendUserConfirmation = (updateRequest) =>
  sendTemplatedEmail('sendUserConfirmation', updateRequest);

/** Customer: a developer was assigned (type 'project' or 'update'). */
const sendDeveloperAssignedNotification = (entity, type = 'update') =>
  sendTemplatedEmail('sendDeveloperAssignedNotification', entity, type);

/** Customer: their update request is completed. */
const sendUpdateCompletedNotification = (updateRequest) =>
  sendTemplatedEmail('sendUpdateCompletedNotification', updateRequest);

/** Developer: new project or update assignment (type 'project' or 'update'). */
const sendDeveloperAssignmentEmail = (entity, type = 'update') =>
  sendTemplatedEmail('sendDeveloperAssignmentEmail', entity, type);

/** Customer: purchase confirmed, with the invoice PDF (paymentDetails.invoiceBuffer). */
const sendPurchaseConfirmationEmail = (order, paymentDetails) =>
  sendTemplatedEmail('sendPurchaseConfirmationEmail', order, paymentDetails);

/** Customer: 1 year monthly limited plan activated, with the paid invoice PDF. */
const sendMonthlyLimitedPlanActivationEmail = (order, paymentDetails) =>
  sendTemplatedEmail('sendMonthlyLimitedPlanActivationEmail', order, paymentDetails);

/** Admins: a purchase was confirmed. */
const sendAdminPurchaseConfirmationEmail = (order, paymentDetails) =>
  sendTemplatedEmail('sendAdminPurchaseConfirmationEmail', order, paymentDetails);

/** Admins: a UPI order waits for approval. */
const sendAdminUPIPendingNotification = (order) =>
  sendTemplatedEmail('sendAdminUPIPendingNotification', order);

/** Customer: their update plan was closed. */
const sendPlanClosureEmailToCustomer = (order, closureReason, closedDate) =>
  sendTemplatedEmail('sendPlanClosureEmailToCustomer', order, closureReason, closedDate);

/** Admins: a customer plan was closed. */
const sendPlanClosureEmailToAdmin = (order, closureReason, closedByAdmin, closedDate) =>
  sendTemplatedEmail('sendPlanClosureEmailToAdmin', order, closureReason, closedByAdmin, closedDate);

/** Customer: wallet recharge confirmed. */
const sendWalletRechargeConfirmationEmail = (user, transaction) =>
  sendTemplatedEmail('sendWalletRechargeConfirmationEmail', user, transaction);

/** Customer: an order payment was rejected. */
const sendPaymentRejectionEmail = (user, transaction, order, rejectionReason) =>
  sendTemplatedEmail('sendPaymentRejectionEmail', user, transaction, order, rejectionReason);

/** Customer: project cancelled, with every refund leg and its reference. */
const sendProjectCancellationEmail = (user, order, refunds = [], cancellationReason = '') =>
  sendTemplatedEmail('sendProjectCancellationEmail', user, order, refunds, cancellationReason);

/** Customer: the admin opened a new project for them (adminCreateProjectOrder.js). */
const sendProjectCreatedEmail = (user, order, invoice) =>
  sendTemplatedEmail('sendProjectCreatedEmail', user, order, invoice);

/** Customer: wallet recharge rejected. */
const sendWalletRechargeRejectionEmail = (user, transaction, rejectionReason) =>
  sendTemplatedEmail('sendWalletRechargeRejectionEmail', user, transaction, rejectionReason);

/** Customer: a lead became a client and their account is ready (convertLead.js). */
const sendClientAccountCreatedEmail = (user) =>
  sendTemplatedEmail('sendClientAccountCreatedEmail', user);

/** Visitor: their contact form was received. */
const sendContactFormConfirmation = (contactData) =>
  sendTemplatedEmail('sendContactFormConfirmation', contactData);

/** Admins: a new contact (account creation) request. */
const sendContactRequestNotification = (contactData, adminEmails) =>
  sendTemplatedEmail('sendContactRequestNotification', contactData, adminEmails);

/** Visitor: their callback request was received. */
const sendCallbackConfirmation = (callbackData) =>
  sendTemplatedEmail('sendCallbackConfirmation', callbackData);

/** Admins: a new callback request. */
const sendCallbackRequestNotification = (callbackData, adminEmails) =>
  sendTemplatedEmail('sendCallbackRequestNotification', callbackData, adminEmails);

/** Customer: a project milestone was completed. */
const sendProjectUpdateEmail = (user, updateData, project) =>
  sendTemplatedEmail('sendProjectUpdateEmail', user, updateData, project);

/** Customer: a new message about their project. */
const sendProjectMessageEmail = (user, messageData, project) =>
  sendTemplatedEmail('sendProjectMessageEmail', user, messageData, project);

/** Customer: monthly plan renewed and its bill is due, with the invoice PDF. */
const sendMonthlyInvoiceEmail = (user, order, invoice, invoicePdfBuffer) =>
  sendTemplatedEmail('sendMonthlyInvoiceEmail', user, order, invoice, invoicePdfBuffer);

/** Admin: a monthly bill was generated. */
const sendAdminAutoRenewalNotification = (user, order, invoice) =>
  sendTemplatedEmail('sendAdminAutoRenewalNotification', user, order, invoice);

/**
 * Generate invoice PDF for an order
 * @param {Object} order - The populated order object
 * @param {Object} paymentDetails - Payment method information
 * @returns {Promise<Buffer>} - PDF buffer
 */
const generateInvoicePdf = async (order, paymentDetails) => {
  try {
    // For this implementation, you would use a PDF generation library like PDFKit
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({
      margin: 50,
      size: 'A4'
    });
    
    // Add company information
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.moveDown();
    
    // Add company logo if available
    // doc.image('path_to_logo.png', 50, 45, { width: 100 });
    
    doc.fontSize(10);
    doc.text('VA Computers', { align: 'right' });
    doc.text('VA Computers, Near New Bus Stand', { align: 'right' });
    doc.text('Majitha, 143601 ', { align: 'right' });
    doc.text('Email: contact@merasofware.com', { align: 'right' });
    
    doc.moveDown();
    
    // Customer Information
    doc.fontSize(12).text('Bill To:');
    doc.fontSize(10);
    doc.text(`Customer: ${order.userId.name}`);
    doc.text(`Email: ${order.userId.email}`);
    doc.text(`Invoice Date: ${formatIndiaDate(Date.now())}`);
    doc.text(`Invoice #: INV-${order._id}`);
    
    doc.moveDown();

    // Invoice Items Table
    const tableTop = doc.y + 20;
    const itemCodeX = 50;
    const descriptionX = 150;
    const quantityX = 350;
    const priceX = 400;
    const amountX = 450;
    
    doc.fontSize(10)
      .text('Item', itemCodeX, tableTop)
      .text('Description', descriptionX, tableTop)
      .text('Qty', quantityX, tableTop)
      .text('Price', priceX, tableTop)
      .text('Amount', amountX, tableTop);
    
    // Draw a line
    doc.moveTo(50, tableTop + 15)
      .lineTo(550, tableTop + 15)
      .stroke();
    
    const productName = getOrderDisplayName(order);
    const itemY = tableTop + 25;
    
    doc.text(String(order.productId?._id || order._id).substring(0, 8), itemCodeX, itemY)
      .text(productName, descriptionX, itemY)
      .text(order.quantity.toString(), quantityX, itemY)
      .text(`₹${order.price.toLocaleString()}`, priceX, itemY)
      .text(`₹${(order.price * order.quantity).toLocaleString()}`, amountX, itemY);
    
    doc.moveTo(50, itemY + 20)
      .lineTo(550, itemY + 20)
      .stroke();
    
    // Handle discount if applicable
    let currentY = itemY + 30;
    
    if (order.discountAmount > 0) {
      doc.text('Discount:', 350, currentY)
        .text(`-₹${order.discountAmount.toLocaleString()}`, amountX, currentY);
      currentY += 15;
    }
    
    // Draw the total
    doc.fontSize(12)
      .text('Total:', 350, currentY)
      .text(`₹${order.price.toLocaleString()}`, amountX, currentY);
    
    currentY += 30;

    // If partial payment, show payment plan
    if (order.isPartialPayment) {
      currentY += 30;
      doc.fontSize(12).text('Payment Plan', 50, currentY);
      currentY += 15;
      
      // Payment plan table header
      doc.fontSize(10)
        .text('Installment', 50, currentY)
        .text('Amount', 150, currentY)
        .text('Due Date', 250, currentY);

      currentY += 15;

      // Draw a line
      doc.moveTo(50, currentY)
        .lineTo(550, currentY)
        .stroke();

      currentY += 15;

      // List installments
      order.installments.forEach((installment, index) => {
        doc.text(`#${installment.installmentNumber} (${installment.percentage}%)`, 50, currentY)
          .text(`₹${installment.amount.toLocaleString()}`, 150, currentY)
          .text(installment.dueDate ? formatIndiaDate(installment.dueDate) : 'N/A', 250, currentY);

        currentY += 20;
      });
    }
    
    // Footer
    const footerTop = 700;
    doc.fontSize(10)
      .text('Thank you for your business!', 50, footerTop, { align: 'center' })
      .text(`Generated on ${formatIndiaDateTime(Date.now())}`, 50, footerTop + 15, { align: 'center' });
    
    // Handle document streaming properly
    return new Promise((resolve, reject) => {
      const chunks = [];
      
      doc.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      doc.on('end', () => {
        const result = Buffer.concat(chunks);
        console.log("PDF generation complete, size:", result.length);
        resolve(result);
      });
      
      doc.on('error', (err) => {
        console.error("PDF generation error:", err);
        reject(err);
      });
      
      // End the document to finalize it
      doc.end();
    });
  } catch (error) {
    console.error('Error generating invoice PDF:', error);
    throw error;
  }
};

/**
 * Generate monthly invoice PDF
 * @param {Object} user - User object
 * @param {Object} order - Order/plan object
 * @param {Object} invoice - Invoice details
 * @returns {Promise<Buffer>} - PDF buffer
 */
const generateMonthlyInvoicePdf = async (user, order, invoice) => {
  try {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({
      margin: 50,
      size: 'A4'
    });

    // Header
    doc.fontSize(24).text('MONTHLY INVOICE', { align: 'center' });
    doc.moveDown();

    // Company Info (Right aligned)
    doc.fontSize(10);
    doc.text('VA Computers', { align: 'right' });
    doc.text('Near New Bus Stand', { align: 'right' });
    doc.text('Majitha, 143601', { align: 'right' });
    doc.text('Email: vacomputers.com@gmail.com', { align: 'right' });

    doc.moveDown(2);

    // Invoice Info Box
    doc.fontSize(12).fillColor('#333');
    doc.rect(50, doc.y, 500, 120).stroke();

    const boxY = doc.y + 10;
    doc.fontSize(10);
    doc.text(`Invoice Number: ${invoice.invoiceNumber}`, 60, boxY);
    doc.text(`Invoice Date: ${formatIndiaDate(invoice.invoiceDate)}`, 60, boxY + 20);
    doc.text(`Due Date: ${formatIndiaDate(invoice.dueDate)}`, 60, boxY + 40);
    doc.text(`Status: UNPAID`, 60, boxY + 60, { fillColor: '#e74c3c' });
    doc.fillColor('#333');
    doc.text(`Renewal Month: ${invoice.renewalMonth} of 12`, 60, boxY + 80);

    doc.moveDown(8);

    // Bill To
    doc.fontSize(12).text('Bill To:');
    doc.fontSize(10);
    doc.text(`Customer: ${user.name}`);
    doc.text(`Email: ${user.email}`);

    doc.moveDown(2);

    // Plan Details
    doc.fontSize(12).text('Plan Details:');
    doc.fontSize(10);
    doc.text(`Plan Name: ${order.productId.serviceName}`);
    doc.text(`Billing Period: ${formatIndiaDate(invoice.renewalPeriodStart)} - ${formatIndiaDate(invoice.renewalPeriodEnd)}`);
    doc.text(`Updates Included: 1 update per month`);

    doc.moveDown(2);

    // Amount Table
    const tableTop = doc.y;
    doc.fontSize(10)
      .text('Description', 50, tableTop)
      .text('Amount', 450, tableTop);

    doc.moveTo(50, tableTop + 15)
      .lineTo(550, tableTop + 15)
      .stroke();

    const itemY = tableTop + 25;
    doc.text(`Monthly Plan Charge (${formatIndiaDate(invoice.renewalPeriodStart)} - ${formatIndiaDate(invoice.renewalPeriodEnd)})`, 50, itemY)
      .text(`₹${invoice.amount.toLocaleString()}`, 450, itemY);

    doc.moveTo(50, itemY + 20)
      .lineTo(550, itemY + 20)
      .stroke();

    // Total
    doc.fontSize(14).fillColor('#000')
      .text('Total Amount Due:', 300, itemY + 35)
      .text(`₹${invoice.amount.toLocaleString()}`, 450, itemY + 35);

    doc.moveDown(3);

    // Payment Instructions
    doc.fontSize(12).fillColor('#333').text('Payment Instructions:', 50, doc.y);
    doc.fontSize(10);
    doc.text('Please make payment within 7 days to continue service.', 50, doc.y + 5);

    doc.moveDown();
    doc.text('1. UPI Payment: vacomputers.com@okhdfcbank');
    doc.text('2. Visit Office: VA Computers, Majitha');

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#666');
    doc.text('After payment, please share transaction screenshot with us.', { align: 'center' });

    // Footer
    const footerTop = 700;
    doc.fontSize(10).fillColor('#333')
      .text('Thank you for your business!', 50, footerTop, { align: 'center' })
      .fontSize(8).fillColor('#999')
      .text(`Generated on ${formatIndiaDateTime(Date.now())}`, 50, footerTop + 15, { align: 'center' });

    // Handle document streaming
    return new Promise((resolve, reject) => {
      const chunks = [];

      doc.on('data', (chunk) => {
        chunks.push(chunk);
      });

      doc.on('end', () => {
        const result = Buffer.concat(chunks);
        console.log("Monthly invoice PDF generated, size:", result.length);
        resolve(result);
      });

      doc.on('error', (err) => {
        console.error("Monthly invoice PDF generation error:", err);
        reject(err);
      });

      doc.end();
    });
  } catch (error) {
    console.error('Error generating monthly invoice PDF:', error);
    throw error;
  }
};

module.exports = {
  prepareTemplatedMail,
  sendUpdateRequestNotification,
  sendUserConfirmation,
  sendDeveloperAssignedNotification,
  sendUpdateCompletedNotification,
  sendDeveloperAssignmentEmail,
  sendPurchaseConfirmationEmail,
  sendMonthlyLimitedPlanActivationEmail,
  sendAdminPurchaseConfirmationEmail,
  sendAdminUPIPendingNotification,
  sendPlanClosureEmailToCustomer,
  sendPlanClosureEmailToAdmin,
  sendWalletRechargeConfirmationEmail,
  sendPaymentRejectionEmail,
  sendProjectCancellationEmail,
  sendProjectCreatedEmail,
  sendWalletRechargeRejectionEmail,
  sendClientAccountCreatedEmail,
  sendContactFormConfirmation,
  sendContactRequestNotification,
  sendCallbackConfirmation,
  sendCallbackRequestNotification,
  sendProjectUpdateEmail,
  sendProjectMessageEmail,
  sendMonthlyInvoiceEmail,
  sendAdminAutoRenewalNotification,
  generateInvoicePdf,
  generateMonthlyInvoicePdf
};

// PDFs remain pure helpers; every mail builder carries its stable central event.
for (const [key, builder] of Object.entries(module.exports)) {
  if (key.startsWith('send')) module.exports[key] = withEvent(key, builder);
}
