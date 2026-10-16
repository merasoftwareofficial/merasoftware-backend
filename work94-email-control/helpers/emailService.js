const { Resend } = require('resend');
const { getOrderDisplayName, getOrderCategory } = require('./orderPresentation');

// Initialize Resend with API key
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Send notification to admins about new update request
 * @param {Object} updateRequest - The populated update request object
 * @param {Array|String} adminEmails - Admin email addresses
 */
const sendUpdateRequestNotification = async (updateRequest, adminEmails) => {
  try {
    // Make sure we have an array of emails
    const emails = Array.isArray(adminEmails) ? adminEmails : [adminEmails];
    
    // Format instructions for better readability
    const formattedInstructions = updateRequest.instructions && updateRequest.instructions.length > 0
      ? updateRequest.instructions.map(instr => `- ${instr.text}`).join('\n')
      : 'No instructions provided';
    
    // Get file information
    const fileInfo = updateRequest.files && updateRequest.files.length > 0
      ? `${updateRequest.files.length} file(s) uploaded`
      : 'No files uploaded';
    
    // Email content
    const emailData = {
      from: `${process.env.FROM_NAME || 'Website Update Service'} <${process.env.FROM_EMAIL}>`,
      to: emails,
      subject: 'New Website Update Request Submitted',
      html: `
        <h2>New Website Update Request</h2>
        <p><strong>Client:</strong> ${updateRequest.userId.name} (${updateRequest.userId.email})</p>
        <p><strong>Plan:</strong> ${updateRequest.updatePlanId.productId.serviceName}</p>
        <p><strong>Files:</strong> ${fileInfo}</p>
        <h3>Instructions:</h3>
        <pre style="background-color: #f5f5f5; padding: 10px; border-radius: 5px;">${formattedInstructions}</pre>
        <p>Please log into the admin dashboard to view the complete details and assign a developer.</p>
        <p>
          <a href="${process.env.ADMIN_DASHBOARD_URL}/update-requests" 
             style="display: inline-block; padding: 10px 15px; background-color: #4A90E2; color: white; text-decoration: none; border-radius: 5px;">
            View Request
          </a>
        </p>
      `
    };
    
    // Send email
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending admin notification email:', error);
      return false;
    }
    
    console.log('Admin notification email sent successfully:', data);
    return true;
  } catch (error) {
    console.error('Error sending admin notification email:', error);
    return false;
  }
};

/**
 * Send confirmation email to user
 * @param {Object} updateRequest - The populated update request object
 */
const sendUserConfirmation = async (updateRequest) => {
  try {
    const emailData = {
      from: `${process.env.FROM_NAME || 'Website Update Service'} <${process.env.FROM_EMAIL}>`,
      to: [updateRequest.userId.email],
      subject: 'Your Website Update Request Has Been Received',
      html: `
        <h2>Update Request Confirmation</h2>
        <p>Hello ${updateRequest.userId.name},</p>
        <p>We have received your website update request for your <strong>${updateRequest.updatePlanId.productId.serviceName}</strong> plan.</p>
        <p>Our team will review your request and start working on it as soon as possible.</p>
        <p>You will receive notifications when there are updates or when your request has been completed.</p>
        <p>Thank you for your business!</p>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending user confirmation email:', error);
      return false;
    }
    
    console.log('User confirmation email sent successfully:', data);
    return true;
  } catch (error) {
    console.error('Error sending user confirmation email:', error);
    return false;
  }
};

/**
 * Send notification to user when developer is assigned
 * @param {Object} entity - The populated project/update object
 * @param {String} type - 'project' or 'update'
 */
const sendDeveloperAssignedNotification = async (entity, type = 'update') => {
  try {
    // Content और subject को type के अनुसार set करें
    let subject, content;
    
    if (type === 'project') {
      subject = 'Developer Assigned to Your Website Project';
      content = `
        <h2>Developer Has Been Assigned</h2>
        <p>Hello ${entity.userId.name},</p>
        <p>We're pleased to inform you that a developer has been assigned to your website project.</p>
        <p><strong>Project:</strong> ${getOrderDisplayName(entity, 'Project')}</p>
        <p><strong>Developer:</strong> ${entity.assignedDeveloper.name}</p>
        <p>Your project is now in progress, and you'll receive further updates as work proceeds.</p>
        <p>Thank you for your patience!</p>
      `;
    } else {
      subject = 'Update on Your Website Update Request';
      content = `
        <h2>Developer Has Been Assigned</h2>
        <p>Hello ${entity.userId.name},</p>
        <p>We're pleased to inform you that a developer has been assigned to your website update request.</p>
        <p><strong>Developer:</strong> ${entity.assignedDeveloper.name}</p>
        <p>Your request is now in progress, and you'll receive further updates as work proceeds.</p>
        <p>Thank you for your patience!</p>
      `;
    }
    
    const emailData = {
      from: `${process.env.FROM_NAME || 'Website Service'} <${process.env.FROM_EMAIL}>`,
      to: [entity.userId.email],
      subject: subject,
      html: content
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending developer assigned notification:', error);
      return false;
    }
    
    console.log('Developer assigned notification sent successfully to client:', data);
    return true;
  } catch (error) {
    console.error('Error sending developer assigned notification:', error);
    return false;
  }
};

/**
 * Send notification to user when update is completed
 * @param {Object} updateRequest - The populated update request object
 */
const sendUpdateCompletedNotification = async (updateRequest) => {
  try {
    const emailData = {
      from: `${process.env.FROM_NAME || 'Website Update Service'} <${process.env.FROM_EMAIL}>`,
      to: [updateRequest.userId.email],
      subject: 'Your Website Update Has Been Completed',
      html: `
        <h2>Update Request Completed</h2>
        <p>Hello ${updateRequest.userId.name},</p>
        <p>We're happy to inform you that your website update request has been completed successfully.</p>
        <p>Please take some time to review the changes. If you have any questions or need any adjustments, please let us know.</p>
        <p>Thank you for choosing our service!</p>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending update completed notification:', error);
      return false;
    }
    
    console.log('Update completed notification sent successfully:', data);
    return true;
  } catch (error) {
    console.error('Error sending update completed notification:', error);
    return false;
  }
};

/**
 * Send notification email to developer about new assignment
 * @param {Object} entity - The populated project/update object
 * @param {String} type - 'project' or 'update'
 */
const sendDeveloperAssignmentEmail = async (entity, type = 'update') => {
  try {
    // Make sure we have developer details
    if (!entity.assignedDeveloper || !entity.assignedDeveloper.email) {
      console.warn('No developer email found for sending notification');
      return false;
    }
    
    // Content और subject को type के अनुसार set करें
    let subject, content, dashboardUrl;
    
    if (type === 'project') {
      subject = 'New Website Project Assignment';
      dashboardUrl = '/developer-projects';
      content = `
        <h2>New Project Assignment</h2>
        <p>Hello ${entity.assignedDeveloper.name},</p>
        <p>You have been assigned to work on a new website project.</p>
        <p><strong>Client:</strong> ${entity.userId.name} (${entity.userId.email})</p>
        <p><strong>Service:</strong> ${getOrderDisplayName(entity, 'Project')}</p>
        
        <p>Please log into your developer dashboard to view the complete details and start working on this project.</p>
      `;
    } else {
      subject = 'New Website Update Assignment';
      dashboardUrl = '/developer-update-requests';
      content = `
        <h2>New Update Assignment</h2>
        <p>Hello ${entity.assignedDeveloper.name},</p>
        <p>You have been assigned to work on a website update request.</p>
        <p><strong>Client:</strong> ${entity.userId.name} (${entity.userId.email})</p>
        <p><strong>Service:</strong> ${entity.updatePlanId.productId.serviceName}</p>
        
        <h3>Client Instructions:</h3>
        <div style="background-color: #f5f5f5; padding: 10px; border-radius: 5px;">
          ${entity.instructions && entity.instructions.length > 0
            ? entity.instructions.map(instr => `<p>- ${instr.text}</p>`).join('')
            : '<p>No instructions provided</p>'
          }
        </div>
        
        <p>Please log into your developer dashboard to view the complete details and start working on this request.</p>
      `;
    }
    
    const emailData = {
      from: `${process.env.FROM_NAME || 'Website Service'} <${process.env.FROM_EMAIL}>`,
      to: [entity.assignedDeveloper.email],
      subject: subject,
      html: `
        ${content}
        <p>
          <a href="${process.env.DEVELOPER_DASHBOARD_URL}${dashboardUrl}" 
             style="display: inline-block; padding: 10px 15px; background-color: #4A90E2; color: white; text-decoration: none; border-radius: 5px;">
            View Assignment
          </a>
        </p>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending developer assignment email:', error);
      return false;
    }
    
    console.log('Developer assignment email sent successfully to:', entity.assignedDeveloper.email, data);
    return true;
  } catch (error) {
    console.error('Error sending developer assignment email:', error);
    return false;
  }
};

/**
 * Send purchase confirmation email to user
 * @param {Object} order - The populated order object with user and product details
 * @param {Object} paymentDetails - Information about the payment
 * @returns {Promise<Boolean>} - Success status
 */
const sendPurchaseConfirmationEmail = async (order, paymentDetails) => {
  try {
    if (!order.userId || !order.userId.email) {
      console.warn('No user email found for sending purchase confirmation');
      return false;
    }
    
    // Get discount information if available
    const discount = order.discountAmount || 0;
    const originalPrice = order.originalPrice || order.price;
    const finalPrice = order.price;
    const couponApplied = order.couponApplied || 'None';
    
    // Payment method info
    const paymentMethod = paymentDetails.method || 'Wallet';
    
    // Format for partial payment information if applicable
    let paymentInfo = '';
    if (order.isPartialPayment) {
      paymentInfo = `
        <div style="margin-top: 15px; margin-bottom: 15px; background-color: #f8f9fa; padding: 15px; border-radius: 5px;">
          <h3 style="margin-top: 0; color: #333;">Installment Plan</h3>
          <p>This purchase is being made under an installment plan.</p>
          <p><strong>Current Payment:</strong> ₹${(order.paidAmount || 0).toLocaleString()}</p>
          <p><strong>Remaining Amount:</strong> ₹${(order.remainingAmount || 0).toLocaleString()}</p>
          <p><strong>Total Value:</strong> ₹${(order.totalAmount || 0).toLocaleString()}</p>
        </div>
      `;
    }
    
    const emailData = {
      from: `${process.env.FROM_NAME || 'Your Company'} <${process.env.FROM_EMAIL}>`,
      to: [order.userId.email],
      subject: 'Thank You for Your Purchase!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Purchase Confirmation</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Hello ${order.userId.name},</p>
            
            <p>Thank you for your purchase! We're excited to confirm your order details:</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">${getOrderDisplayName(order)}</h2>
              <p><strong>Category:</strong> ${getOrderCategory(order, 'Service').split('_').join(' ')}</p>
              <p><strong>Quantity:</strong> ${order.quantity}</p>
              <p><strong>Original Price:</strong> ₹${originalPrice.toLocaleString()}</p>
              <p><strong>Coupon Applied:</strong> ${couponApplied}</p>
              ${discount > 0 ? `<p><strong>Discount:</strong> ₹${discount.toLocaleString()}</p>` : ''}
              <p><strong>Final Price:</strong> ₹${finalPrice.toLocaleString()}</p>
              <p><strong>Payment Method:</strong> ${paymentMethod}</p>
            </div>
                        
            ${paymentInfo}
            
            <p>We've attached an invoice to this email for your records.</p>
            
            <p>If you have any questions about your purchase, please don't hesitate to contact our support team.</p>
            
            <p>Thank you for choosing our services!</p>
            
            <p>Best regards,<br>Mera Software Team</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: `Invoice-${order._id}.pdf`,
          content: paymentDetails.invoiceBuffer,
        },
      ],
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending purchase confirmation email:', error);
      return false;
    }
    
    console.log('Purchase confirmation email sent successfully to:', order.userId.email, data);
    return true;
  } catch (error) {
    console.error('Error sending purchase confirmation email:', error);
    return false;
  }
};

/**
 * Send activation email for Monthly Limited Plan (1 update per month for 1 year)
 * @param {Object} order - The populated order object
 * @param {Object} paymentDetails - Payment method information
 * @returns {Promise<Boolean>} - Success status
 */
const sendMonthlyLimitedPlanActivationEmail = async (order, paymentDetails) => {
  try {
    if (!order.userId || !order.userId.email) {
      console.warn('No user email found for sending monthly limited plan activation email');
      return false;
    }

    const emailData = {
      from: `${process.env.FROM_NAME || 'VA Computers'} <${process.env.FROM_EMAIL}>`,
      to: [order.userId.email],
      subject: '🎉 1 Year Plan Activated - Monthly Limited Update Plan',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; border: 1px solid #e0e0e0;">
          <!-- Header -->
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; text-align: center;">
            <h1 style="margin: 0; font-size: 28px;">🎉 Plan Activated Successfully!</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Your 1 Year Website Update Plan is Now Active</p>
          </div>

          <!-- Main Content -->
          <div style="padding: 30px 20px;">
            <p style="font-size: 16px; color: #333; margin-bottom: 20px;">Hello <strong>${order.userId.name}</strong>,</p>

            <div style="background-color: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin-bottom: 25px; border-radius: 4px;">
              <p style="margin: 0; color: #2e7d32; font-size: 15px;">
                ✅ <strong>Congratulations!</strong> Your <strong>1 Year Website Update Plan</strong> is now <strong>ACTIVE</strong>.
              </p>
            </div>

            <!-- Plan Details -->
            <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
              <h2 style="margin: 0 0 15px 0; color: #667eea; font-size: 20px; border-bottom: 2px solid #667eea; padding-bottom: 10px;">📋 Your Plan Details</h2>

              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; color: #555; font-size: 14px;">Plan Name:</td>
                  <td style="padding: 8px 0; color: #333; font-weight: bold; font-size: 14px;">${order.productId.serviceName}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #555; font-size: 14px;">Plan Duration:</td>
                  <td style="padding: 8px 0; color: #333; font-weight: bold; font-size: 14px;">1 Year (12 Months)</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #555; font-size: 14px;">Monthly Updates:</td>
                  <td style="padding: 8px 0; color: #333; font-weight: bold; font-size: 14px;">1 Update Per Month</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #555; font-size: 14px;">Monthly Renewal Cost:</td>
                  <td style="padding: 8px 0; color: #333; font-weight: bold; font-size: 14px;">₹${(order.productId.monthlyRenewalPrice || 3000).toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; color: #555; font-size: 14px;">Activation Date:</td>
                  <td style="padding: 8px 0; color: #333; font-weight: bold; font-size: 14px;">${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</td>
                </tr>
              </table>
            </div>

            <!-- How It Works -->
            <div style="background-color: #fff3e0; border-left: 4px solid #ff9800; padding: 15px; margin-bottom: 25px; border-radius: 4px;">
              <h3 style="margin: 0 0 10px 0; color: #e65100; font-size: 16px;">🔄 How Your Auto-Renewal Works</h3>
              <ul style="margin: 0; padding-left: 20px; color: #555; font-size: 14px; line-height: 1.8;">
                <li>Your plan will automatically renew <strong>every month for the next 12 months</strong></li>
                <li>You'll receive <strong>1 website update per month</strong></li>
                <li>Monthly billing of <strong>₹${(order.productId.monthlyRenewalPrice || 3000).toLocaleString()}</strong> will be sent at the end of each month</li>
                <li>Your plan remains active even if payment is pending</li>
                <li>Updates will be processed after payment confirmation</li>
              </ul>
            </div>

            <!-- Important Note About Upgrades -->
            <div style="background-color: #e3f2fd; border-left: 4px solid #2196f3; padding: 15px; margin-bottom: 25px; border-radius: 4px;">
              <h3 style="margin: 0 0 10px 0; color: #1565c0; font-size: 16px;">⚠️ Important: Plan Upgrade Policy</h3>
              <p style="margin: 0; color: #555; font-size: 14px; line-height: 1.7;">
                If you wish to <strong>upgrade your plan</strong> to a higher tier, please inform us at least <strong>24 working hours before your next renewal date</strong>.
                This ensures a smooth transition without any service interruption.
              </p>
            </div>

            <!-- What's Next -->
            <div style="margin-bottom: 25px;">
              <h3 style="color: #667eea; font-size: 18px; margin-bottom: 15px;">✨ What's Next?</h3>
              <ol style="margin: 0; padding-left: 20px; color: #555; font-size: 14px; line-height: 1.8;">
                <li>Login to your dashboard to submit your monthly update requests</li>
                <li>Track your plan status and remaining days</li>
                <li>View and download your monthly invoices</li>
                <li>Contact us anytime for support or upgrades</li>
              </ol>
            </div>

            <!-- Contact Information -->
            <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
              <h3 style="margin: 0 0 15px 0; color: #667eea; font-size: 16px;">📞 Need Help? Contact Us</h3>

              <table style="width: 100%; font-size: 14px; color: #555;">
                <tr>
                  <td style="padding: 5px 0;"><strong>📧 Email:</strong></td>
                  <td style="padding: 5px 0;">contact@merasoftware.com</td>
                </tr>
                <tr>
                  <td style="padding: 5px 0;"><strong>📱 Phone:</strong></td>
                  <td style="padding: 5px 0;">+91 92565 37003</td>
                </tr>
                <tr>
                  <td style="padding: 5px 0;"><strong>🏢 Office:</strong></td>
                  <td style="padding: 5px 0;">VA Computers, Near New Bus Stand, Majitha, 143601</td>
                </tr>
              </table>

              <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #ddd;">
                <p style="margin: 0 0 10px 0; font-size: 14px; color: #333;"><strong>💳 Payment Options:</strong></p>
                <p style="margin: 5px 0; font-size: 13px; color: #666;">
                  <strong>UPI:</strong> vacomputers.com@okhdfcbank
                </p>
              </div>
            </div>

            <p style="font-size: 14px; color: #555; line-height: 1.7;">
              We've attached your <strong>paid invoice</strong> to this email for your records.
            </p>

            <p style="font-size: 14px; color: #555; line-height: 1.7; margin-top: 20px;">
              Thank you for choosing <strong>VA Computers</strong>! We're committed to providing you with the best service.
            </p>

            <p style="font-size: 14px; color: #333; margin-top: 25px;">
              <strong>Best regards,</strong><br>
              Mera Software Team<br>
              <span style="color: #667eea;">Your Digital Partner</span>
            </p>
          </div>

          <!-- Footer -->
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; border-top: 1px solid #e0e0e0;">
            <p style="margin: 0; font-size: 12px; color: #666;">
              © ${new Date().getFullYear()} Mera Software. All rights reserved.
            </p>
            <p style="margin: 5px 0 0 0; font-size: 11px; color: #999;">
              This is an automated email. Please do not reply to this email.
            </p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: `Invoice-${order._id}.pdf`,
          content: paymentDetails.invoiceBuffer,
        },
      ],
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending monthly limited plan activation email:', error);
      return false;
    }

    console.log('Monthly limited plan activation email sent successfully to:', order.userId.email, data);
    return true;
  } catch (error) {
    console.error('Error sending monthly limited plan activation email:', error);
    return false;
  }
};

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
    doc.text(`Invoice Date: ${new Date().toLocaleDateString()}`);
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
          .text(installment.dueDate ? new Date(installment.dueDate).toLocaleDateString() : 'N/A', 250, currentY);

        currentY += 20;
      });
    }
    
    // Footer
    const footerTop = 700;
    doc.fontSize(10)
      .text('Thank you for your business!', 50, footerTop, { align: 'center' })
      .text(`Generated on ${new Date().toLocaleString()}`, 50, footerTop + 15, { align: 'center' });
    
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
 * Send wallet recharge confirmation email
 * @param {Object} user - User object with name and email
 * @param {Object} transaction - Transaction details
 * @returns {Promise<Boolean>} - Success status
 */
const sendWalletRechargeConfirmationEmail = async (user, transaction) => {
  try {
    if (!user || !user.email) {
      console.warn('No user email found for sending wallet recharge confirmation');
      return false;
    }
    
    const emailData = {
      from: `${process.env.FROM_NAME || 'Your Company'} <${process.env.FROM_EMAIL}>`,
      to: [user.email],
      subject: 'Wallet Recharge Confirmation',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Wallet Recharge Confirmation</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Hello ${user.name},</p>
            
            <p>We're pleased to confirm that your wallet has been successfully recharged!</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">Recharge Details</h2>
              <p><strong>Transaction ID:</strong> ${transaction.transactionId}</p>
              <p><strong>Amount:</strong> ₹${transaction.amount.toLocaleString()}</p>
              <p><strong>Date:</strong> ${new Date(transaction.date).toLocaleString()}</p>
              <p><strong>Payment Method:</strong> ${transaction.paymentMethod || 'UPI'}</p>
              ${transaction.upiTransactionId ? `<p><strong>UPI Reference:</strong> ${transaction.upiTransactionId}</p>` : ''}
            </div>
            
            <p>Your updated wallet balance is now reflected in your account.</p>
            
            <p>If you have any questions about this transaction, please contact our support team.</p>
            
            <p>Thank you for choosing our services!</p>
            
            <p>Best regards,<br>Mera Software Team</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending wallet recharge confirmation email:', error);
      return false;
    }
    
    console.log('Wallet recharge confirmation email sent successfully to:', user.email, data);
    return true;
  } catch (error) {
    console.error('Error sending wallet recharge confirmation email:', error);
    return false;
  }
};

/**
 * Send payment rejection email
 * @param {Object} user - User object with name and email
 * @param {Object} transaction - Transaction details
 * @param {Object} order - Order details if applicable
 * @param {String} rejectionReason - Reason for rejection
 * @returns {Promise<Boolean>} - Success status
 */
const sendPaymentRejectionEmail = async (user, transaction, order, rejectionReason) => {
  try {
    if (!user || !user.email) {
      console.warn('No user email found for sending payment rejection notification');
      return false;
    }
    
    // Different content based on whether this is an order payment or wallet recharge
    let subject, heading, details;
    
    if (order) {
      // For order payment rejections
      subject = 'Order Payment Rejected';
      heading = 'Order Payment Rejected';
      details = `
        <p>We regret to inform you that your payment for the following order has been rejected:</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h2 style="margin-top: 0; color: #333;">Order Details</h2>
          <p><strong>Product:</strong> ${getOrderDisplayName(order)}</p>
          <p><strong>Transaction ID:</strong> ${transaction.transactionId}</p>
          <p><strong>Amount:</strong> ₹${transaction.amount.toLocaleString()}</p>
          <p><strong>Date:</strong> ${new Date(transaction.date).toLocaleString()}</p>
        </div>
      `;
    } else {
      // For wallet recharge rejections
      subject = 'Wallet Recharge Rejected';
      heading = 'Wallet Recharge Rejected';
      details = `
        <p>We regret to inform you that your wallet recharge transaction has been rejected:</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h2 style="margin-top: 0; color: #333;">Transaction Details</h2>
          <p><strong>Transaction ID:</strong> ${transaction.transactionId}</p>
          <p><strong>Amount:</strong> ₹${transaction.amount.toLocaleString()}</p>
          <p><strong>Date:</strong> ${new Date(transaction.date).toLocaleString()}</p>
        </div>
      `;
    }
    
    const emailData = {
      from: `${process.env.FROM_NAME || 'Your Company'} <${process.env.FROM_EMAIL}>`,
      to: [user.email],
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #e74c3c; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">${heading}</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Hello ${user.name},</p>
            
            ${details}
            
            <div style="background-color: #fff4f4; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e74c3c;">
              <h3 style="margin-top: 0; color: #e74c3c;">Reason for Rejection</h3>
              <p>${rejectionReason}</p>
            </div>
            
            <p>Please make a new payment if you wish to complete your transaction. If you believe this is an error, please contact our support team.</p>
            
            <p>Thank you for your understanding.</p>
            
            <p>Best regards,<br>Mera Software Team</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending payment rejection email:', error);
      return false;
    }
    
    console.log('Payment rejection email sent successfully to:', user.email, data);
    return true;
  } catch (error) {
    console.error('Error sending payment rejection email:', error);
    return false;
  }
};

/**
 * Send project cancellation + refund email.
 * Every refund leg is listed with the method it went back through — a wallet leg is already
 * in the customer's balance, an external leg carries the reference id the admin got when they
 * sent it, so the customer can look that payment up on their own bank/UPI side.
 * @param {Object} user - User object with name and email
 * @param {Object} order - The cancelled order
 * @param {Array} refunds - Refund legs: { method, amount, referenceId }
 * @param {String} cancellationReason - Why the project was cancelled
 * @returns {Promise<Boolean>} - Success status
 */
const sendProjectCancellationEmail = async (user, order, refunds = [], cancellationReason = '') => {
  try {
    if (!user || !user.email) {
      console.warn('No user email found for sending project cancellation notification');
      return false;
    }

    const METHOD_LABELS = {
      wallet: 'Wallet',
      upi: 'UPI',
      cash: 'Cash',
      bank_transfer: 'Bank Transfer',
      combined: 'Combined',
      demo: 'Demo Credit',
    };

    const refundTotal = refunds.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);

    const refundRows = refunds.map((entry) => {
      const label = METHOD_LABELS[entry.method] || entry.method;
      const note = entry.method === 'wallet'
        ? 'Credited to your wallet'
        : `Reference: ${entry.referenceId || 'N/A'}`;
      return `
        <tr>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee;"><strong>${label}</strong></td>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: right;">₹${Number(entry.amount || 0).toLocaleString()}</td>
          <td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: right; color: #666; font-size: 13px;">${note}</td>
        </tr>
      `;
    }).join('');

    const refundBlock = refunds.length > 0
      ? `
        <div style="background-color: #f0f9f4; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #27ae60;">
          <h3 style="margin-top: 0; color: #27ae60;">Refund Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            ${refundRows}
            <tr>
              <td style="padding: 10px 0;"><strong>Total Refunded</strong></td>
              <td style="padding: 10px 0; text-align: right;"><strong>₹${refundTotal.toLocaleString()}</strong></td>
              <td></td>
            </tr>
          </table>
        </div>
      `
      : '';

    const reasonBlock = cancellationReason
      ? `
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #333;">Reason</h3>
          <p style="margin: 0;">${cancellationReason}</p>
        </div>
      `
      : '';

    const emailData = {
      from: `${process.env.FROM_NAME || 'Your Company'} <${process.env.FROM_EMAIL}>`,
      to: [user.email],
      subject: 'Project Cancelled',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #34495e; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Project Cancelled</h1>
          </div>

          <div style="padding: 20px;">
            <p>Hello ${user.name},</p>

            <p>Your project has been cancelled. The details are below.</p>

            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">Project Details</h2>
              <p><strong>Project:</strong> ${getOrderDisplayName(order)}</p>
              <p><strong>Cancelled On:</strong> ${new Date().toLocaleString()}</p>
            </div>

            ${reasonBlock}
            ${refundBlock}

            <p>If you have any questions about this cancellation or the refund, please contact our support team.</p>

            <p>Best regards,<br>Mera Software Team</p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending project cancellation email:', error);
      return false;
    }

    console.log('Project cancellation email sent successfully to:', user.email, data);
    return true;
  } catch (error) {
    console.error('Error sending project cancellation email:', error);
    return false;
  }
};

/**
 * Send wallet recharge rejection email
 * @param {Object} user - User object with name and email
 * @param {Object} transaction - Transaction details
 * @param {String} rejectionReason - Reason for rejection
 * @returns {Promise<Boolean>} - Success status
 */
const sendWalletRechargeRejectionEmail = async (user, transaction, rejectionReason) => {
  // Use the generic payment rejection function with null order
  return sendPaymentRejectionEmail(user, transaction, null, rejectionReason);
};

/**
 * Send confirmation email to user who submitted contact form
 * @param {Object} contactData - The contact request data
 * @returns {Promise<Boolean>} - Success status
 */
const sendContactFormConfirmation = async (contactData) => {
  try {
    const emailData = {
      from: `${process.env.FROM_NAME || 'VA Computers'} <${process.env.FROM_EMAIL}>`,
      to: [contactData.email],
      subject: 'Thank You for Contacting Us',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #e74c3c; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Thank You for Contacting Us</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Hello ${contactData.name},</p>
            
            <p>Thank you for reaching out to us. We have received your request for account creation.</p>
            
            <p>Our team will review your information and contact you shortly to help set up your account.</p>
            
            <p>If you have any urgent questions, please feel free to call us directly.</p>
            
            <p>Best regards,<br>Mera Software Team</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending contact form confirmation email:', error);
      return false;
    }
    
    console.log('Contact form confirmation email sent successfully to:', contactData.email, data);
    return true;
  } catch (error) {
    console.error('Error sending contact form confirmation email:', error);
    return false;
  }
};

/**
 * Send notification to admin about new contact request
 * @param {Object} contactData - The contact request data
 * @param {Array|String} adminEmails - Admin email addresses
 * @returns {Promise<Boolean>} - Success status
 */
const sendContactRequestNotification = async (contactData, adminEmails) => {
  try {
    // Make sure we have an array of emails
    const emails = Array.isArray(adminEmails) ? adminEmails : [adminEmails];

    const productInfo = contactData.productId ? 
      `<p><strong>Related Product ID:</strong> ${contactData.productId}</p>` : 
      '<p><strong>Related Product:</strong> None</p>';
    
    const emailData = {
      from: `${process.env.FROM_NAME || 'VA Computers'} <${process.env.FROM_EMAIL}>`,
      to: emails,
      subject: 'New Account Creation Request',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">New Account Creation Request</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>A new account creation request has been submitted through the contact form:</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">Contact Details</h2>
              <p><strong>Name:</strong> ${contactData.name}</p>
              <p><strong>Email:</strong> ${contactData.email}</p>
              <p><strong>Phone:</strong> ${contactData.phone}</p>
              <p><strong>Request Type:</strong> Account Creation</p>
              ${productInfo}
              <p><strong>Message:</strong> ${contactData.message}</p>
              <p><strong>Date Submitted:</strong> ${new Date().toLocaleString()}</p>
            </div>
            
            <p>Please reach out to this customer to complete their account setup process.</p>
            
            <p>You can also manage this request from the admin dashboard.</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending admin notification email:', error);
      return false;
    }
    
    console.log('Admin notification email sent successfully:', data);
    return true;
  } catch (error) {
    console.error('Error sending admin notification email:', error);
    return false;
  }
};

/**
 * Send project update email when a checkpoint is completed
 * @param {Object} user - User object with name and email
 * @param {Object} updateData - Update data including checkpoint and message
 * @param {Object} project - The project object
 * @returns {Promise<Boolean>} - Success status
 */
const sendProjectUpdateEmail = async (user, updateData, project) => {
  try {
    // Process link buttons in message
    const processedMessage = processMessageForEmail(updateData.message);

    const emailData = {
      from: `${process.env.FROM_NAME || 'Website Service'} <${process.env.FROM_EMAIL}>`,
      to: [user.email],
      subject: `Project Update: ${updateData.projectName} - Milestone Completed`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Project Update</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Hello ${updateData.clientName},</p>
            
            <p>We have an exciting update on your website project <strong>${updateData.projectName}</strong>!</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">Milestone Completed</h2>
              <p><strong>${updateData.checkpointName}</strong> is now complete!</p>
              <p>${processedMessage}</p>
            </div>
            
            <div style="margin: 20px 0;">
              <p><strong>Project Progress:</strong> ${updateData.projectProgress}% complete</p>
              <div style="background-color: #e0e0e0; height: 20px; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #4CAF50; height: 100%; width: ${updateData.projectProgress}%;"></div>
              </div>
            </div>
            
            <p>${updateData.developerName} is working diligently to move your project forward. If you have any questions or need clarification, please don't hesitate to reach out.</p>
            
            <p>You can log in to your account to view detailed updates and provide feedback.</p>
            
            <p>Thank you for your continued collaboration!</p>
            
            <p>Best regards,<br>Mera Software Team</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending project update email:', error);
      return false;
    }
    
    console.log('Project update email sent successfully to:', user.email, data);
    return true;
  } catch (error) {
    console.error('Error sending project update email:', error);
    return false;
  }
};

/**
 * Message में special link markup और new line को process करता है
 * @param {string} message - Process करने के लिए message
 * @returns {string} - HTML button और break tag के साथ processed message
 */
const processMessageForEmail = (message) => {
  if (!message) return message;
  
  // पहले link button process करें
  // [[Text||URL]] pattern को match करें
  const linkPattern = /\[\[(.+?)\|\|(.+?)\]\]/g;
  
  // इस pattern को HTML button से replace करें
  let processedMessage = message.replace(linkPattern, (match, text, url) => {
    // सुनिश्चित करें कि URL सही है
    let safeUrl = url.trim();
    if (!safeUrl.startsWith('http://') && !safeUrl.startsWith('https://')) {
      safeUrl = 'https://' + safeUrl;
    }
    
    // HTML button बनाएं
    return `
    <div>
      <a href="${safeUrl}" style="background-color: #4A90E2; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">${text.trim()}</a>
    </div>
    `;
  });
  
  // फिर new line character को <br> tag से replace करें
  processedMessage = processedMessage.replace(/\n/g, '<br>');
  
  return processedMessage;
};

/**
 * Send project message email when admin sends a message
 * @param {Object} user - User object with name and email
 * @param {Object} messageData - Message data 
 * @param {Object} project - The project object
 * @returns {Promise<Boolean>} - Success status
 */
const sendProjectMessageEmail = async (user, messageData, project) => {
  try {
    const processedMessage = processMessageForEmail(messageData.message);

    const emailData = {
      from: `${process.env.FROM_NAME || 'Website Service'} <${process.env.FROM_EMAIL}>`,
      to: [user.email],
      subject: `New Message About Your Project: ${messageData.projectName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">New Project Message</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Hello ${messageData.clientName},</p>
            
            <p>You have received a new message regarding your website project <strong>${messageData.projectName}</strong>:</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4A90E2;">
              <p>${processedMessage}</p>
            </div>
            
            <div style="margin: 20px 0;">
              <p><strong>Current Progress:</strong> ${messageData.projectProgress}% complete</p>
              <div style="background-color: #e0e0e0; height: 20px; border-radius: 10px; overflow: hidden;">
                <div style="background-color: #4CAF50; height: 100%; width: ${messageData.projectProgress}%;"></div>
              </div>
            </div>
            
            <p>To view all messages and updates, please log in to your account dashboard.</p>
            
            <p>If you have any questions or need to respond to this message, you can do so through your account or by replying to this email.</p>
            
            <p>Thank you for your continued collaboration!</p>
            
            <p>Best regards,<br>${messageData.developerName}<br>Mera Software Team</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
            <p>If you have any issues, please contact our support team.</p>
          </div>
        </div>
      `
    };
    
    const { data, error } = await resend.emails.send(emailData);
    
    if (error) {
      console.error('Error sending project message email:', error);
      return false;
    }
    
    console.log('Project message email sent successfully to:', user.email, data);
    return true;
  } catch (error) {
    console.error('Error sending project message email:', error);
    return false;
  }
};

/**
 * Send confirmation email to user who submitted callback request
 * @param {Object} callbackData - The callback request data
 * @returns {Promise<Boolean>} - Success status
 */
const sendCallbackConfirmation = async (callbackData) => {
  try {
    const emailData = {
      from: `${process.env.FROM_NAME || 'Mera Software'} <${process.env.FROM_EMAIL}>`,
      to: [callbackData.email],
      subject: 'Thank You for Your Callback Request',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Thank You for Reaching Out!</h1>
          </div>

          <div style="padding: 20px;">
            <p>Hello ${callbackData.name},</p>

            <p>Thank you for requesting a callback from Mera Software.</p>

            <p>We have received your request and our team will contact you within 24 hours to discuss your requirements.</p>

            <p>Best regards,<br>Mera Software Team</p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending callback confirmation email:', error);
      return false;
    }

    console.log('Callback confirmation email sent successfully to:', callbackData.email, data);
    return true;
  } catch (error) {
    console.error('Error sending callback confirmation email:', error);
    return false;
  }
};

/**
 * Send notification to admin about new callback request
 * @param {Object} callbackData - The callback request data
 * @param {Array|String} adminEmails - Admin email addresses
 * @returns {Promise<Boolean>} - Success status
 */
const sendCallbackRequestNotification = async (callbackData, adminEmails) => {
  try {
    // Make sure we have an array of emails
    const emails = Array.isArray(adminEmails) ? adminEmails : [adminEmails];

    const emailData = {
      from: `${process.env.FROM_NAME || 'Mera Software'} <${process.env.FROM_EMAIL}>`,
      to: emails,
      subject: 'New Callback Request',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">New Callback Request</h1>
          </div>

          <div style="padding: 20px;">
            <p>A new callback request has been submitted.</p>

            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">Customer Details</h2>
              <p><strong>Name:</strong> ${callbackData.name}</p>
              <p><strong>Email:</strong> <a href="mailto:${callbackData.email}">${callbackData.email}</a></p>
              <p><strong>Phone:</strong> <a href="tel:${callbackData.phone}">${callbackData.phone}</a></p>
              ${callbackData.message ? `<p><strong>Interested In:</strong> ${callbackData.message}</p>` : '<p><strong>Interested In:</strong> General Inquiry</p>'}
              <p><strong>Date Submitted:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
            </div>

            <p style="background-color: #fff3cd; padding: 10px; border-left: 4px solid #ffc107; margin: 20px 0;">
              <strong>Action Required:</strong> Please contact this customer within 24 hours.
            </p>

            <p>You can reach out to them via email or phone to discuss their requirements.</p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending callback admin notification email:', error);
      return false;
    }

    console.log('Callback admin notification email sent successfully:', data);
    return true;
  } catch (error) {
    console.error('Error sending callback admin notification email:', error);
    return false;
  }
};

/**
 * Send monthly bill/invoice email to user for limited plan
 * @param {Object} user - User object with name and email
 * @param {Object} order - Order/plan object
 * @param {Object} invoice - Invoice details
 * @param {Buffer} invoicePdfBuffer - PDF buffer
 * @returns {Promise<Boolean>} - Success status
 */
const sendMonthlyInvoiceEmail = async (user, order, invoice, invoicePdfBuffer) => {
  try {
    if (!user || !user.email) {
      console.warn('No user email found for sending monthly invoice');
      return false;
    }

    const emailData = {
      from: `${process.env.FROM_NAME || 'VA Computers'} <${process.env.FROM_EMAIL}>`,
      to: [user.email],
      subject: `✅ Plan Activated | ⚠️ Bill Pending - Invoice #${invoice.invoiceNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4A90E2; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Plan Active - Payment Due</h1>
          </div>

          <div style="padding: 20px;">
            <p>Hello ${user.name},</p>

            <p>Hope you're doing well!</p>

            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4caf50;">
              <h3 style="margin-top: 0; color: #2e7d32;">✅ GREAT NEWS - Your Plan is Active!</h3>
              <p style="margin: 5px 0;">Your Website Update Plan has been automatically renewed and is now <strong>ACTIVE</strong>.</p>
              <p style="margin: 5px 0;">You can now submit your website update requests for this month!</p>
            </div>

            <div style="background-color: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
              <h3 style="margin-top: 0; color: #f57c00;">⚠️ IMPORTANT - Payment Pending</h3>
              <p style="margin: 5px 0;">However, your monthly bill is still <strong>DUE</strong> and needs to be cleared.</p>
              <p style="margin: 5px 0; color: #d32f2f;"><strong>Please Note:</strong> You can send website update requests, but your updates will only be processed <strong>AFTER</strong> the bill payment is confirmed.</p>
            </div>

            <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4A90E2;">
              <h2 style="margin-top: 0; color: #333;">📋 BILLING DETAILS</h2>
              <p style="margin: 8px 0;"><strong>Plan:</strong> ${order.productId.serviceName}</p>
              <p style="margin: 8px 0;"><strong>Billing Period:</strong> ${new Date(invoice.renewalPeriodStart).toLocaleDateString('en-GB')} - ${new Date(invoice.renewalPeriodEnd).toLocaleDateString('en-GB')}</p>
              <p style="margin: 8px 0;"><strong>Invoice Number:</strong> ${invoice.invoiceNumber}</p>
              <p style="margin: 8px 0;"><strong>Invoice Date:</strong> ${new Date(invoice.invoiceDate).toLocaleDateString('en-GB')}</p>
              <hr style="border: none; border-top: 1px solid #ddd; margin: 15px 0;">
              <p style="margin: 8px 0; font-size: 18px;"><strong>Amount Due:</strong> <span style="color: #e74c3c; font-size: 24px;">₹${invoice.amount.toLocaleString()}</span></p>
              <p style="margin: 8px 0;"><strong>Payment Due Date:</strong> ${new Date(invoice.dueDate).toLocaleDateString('en-GB')}</p>
              <p style="margin: 8px 0;"><strong>Status:</strong> <span style="background-color: #ffebee; color: #c62828; padding: 4px 8px; border-radius: 4px;">⏳ PAYMENT PENDING</span></p>
            </div>

            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #2e7d32;">📦 PLAN BENEFITS (This Month)</h3>
              <p style="margin: 5px 0;">✓ 1 Website Update Request</p>
              <p style="margin: 5px 0;">✓ Valid for 30 days (${new Date(invoice.renewalPeriodStart).toLocaleDateString('en-GB')} - ${new Date(invoice.renewalPeriodEnd).toLocaleDateString('en-GB')})</p>
              <p style="margin: 5px 0;">✓ Quick turnaround time</p>
            </div>

            <div style="background-color: #fff8e1; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #f57c00;">💳 PAYMENT OPTIONS</h3>

              <p style="margin-top: 15px;"><strong>1. UPI Payment:</strong></p>
              <p style="margin: 5px 0; padding-left: 20px;">UPI ID: <strong style="color: #1976d2;">vacomputers.com@okhdfcbank</strong></p>


              <p style="margin-top: 15px;"><strong>3. Visit Our Office:</strong></p>
              <p style="margin: 5px 0; padding-left: 20px;">VA Computers, Near New Bus Stand</p>
              <p style="margin: 5px 0; padding-left: 20px;">Majitha, 143601</p>
            </div>

            <div style="background-color: #ffebee; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f44336;">
              <h3 style="margin-top: 0; color: #c62828;">📋 PAYMENT INSTRUCTIONS</h3>
              <p style="margin: 5px 0;">📎 Invoice PDF is attached to this email for your records.</p>
              <p style="margin: 5px 0;">⏰ Please make the payment by <strong>${new Date(invoice.dueDate).toLocaleDateString('en-GB')}</strong></p>
              <p style="margin: 5px 0;">📸 After payment, please share the transaction screenshot with us for faster processing.</p>
              <p style="margin: 10px 0 5px 0; color: #d32f2f;"><strong>⚠️ Remember:</strong> Your update requests will be processed only after payment confirmation.</p>
            </div>

            <div style="background-color: #e3f2fd; padding: 12px 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2196f3;">
              <p style="margin: 0; color: #1565c0; font-size: 14px;">
                <strong>ℹ️ Note:</strong> If you have already made the payment, please disregard this reminder. Your payment will be confirmed shortly and reflected in your account.
              </p>
            </div>

            <p>For any queries, feel free to contact us!</p>

            <p>Thank you for your continued business!</p>

            <p>Best regards,<br>Mera Software Team</p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
            <p>VA Computers, Near New Bus Stand, Majitha, 143601</p>
            <p>Email: vacomputers.com@gmail.com</p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: `Invoice-${invoice.invoiceNumber}.pdf`,
          content: invoicePdfBuffer,
        },
      ],
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending monthly invoice email:', error);
      return false;
    }

    console.log('Monthly invoice email sent successfully to:', user.email, data);
    return true;
  } catch (error) {
    console.error('Error sending monthly invoice email:', error);
    return false;
  }
};

/**
 * Send notification to admin about auto-renewal and invoice generation
 * @param {Object} user - User object
 * @param {Object} order - Order/plan object
 * @param {Object} invoice - Invoice details
 * @returns {Promise<Boolean>} - Success status
 */
const sendAdminAutoRenewalNotification = async (user, order, invoice) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'vacomputers.com@gmail.com';

    const emailData = {
      from: `${process.env.FROM_NAME || 'VA Computers'} <${process.env.FROM_EMAIL}>`,
      to: [adminEmail],
      subject: `🔔 Monthly Bill Generated - User: ${user.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #2196F3; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">🔔 Auto-Renewal Alert</h1>
          </div>

          <div style="padding: 20px;">
            <p>Hi Admin,</p>

            <p>A monthly bill has been generated for a user's plan:</p>

            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">User Information</h2>
              <p><strong>Name:</strong> ${user.name}</p>
              <p><strong>Email:</strong> ${user.email}</p>
              <p><strong>User ID:</strong> ${user._id}</p>
            </div>

            <div style="background-color: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
              <h2 style="margin-top: 0; color: #856404;">Invoice Details</h2>
              <p><strong>Invoice Number:</strong> ${invoice.invoiceNumber}</p>
              <p><strong>Plan:</strong> ${order.productId.serviceName}</p>
              <p><strong>Billing Period:</strong> ${new Date(invoice.renewalPeriodStart).toLocaleDateString('en-GB')} - ${new Date(invoice.renewalPeriodEnd).toLocaleDateString('en-GB')}</p>
              <p><strong>Renewal Month:</strong> ${invoice.renewalMonth} of 12</p>
              <p><strong>Amount:</strong> ₹${invoice.amount.toLocaleString()}</p>
              <p><strong>Status:</strong> <span style="background-color: #fff; padding: 4px 8px; border-radius: 4px; color: #e74c3c;">UNPAID</span></p>
              <p><strong>Due Date:</strong> ${new Date(invoice.dueDate).toLocaleDateString('en-GB')}</p>
            </div>

            <div style="background-color: #e3f2fd; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #1976d2;">Plan Status</h3>
              <p><strong>Updates Available:</strong> 1 update for this month</p>
              <p><strong>Yearly Days Remaining:</strong> ${order.totalYearlyDaysRemaining} days</p>
              <p><strong>Current Month Expiry:</strong> ${new Date(order.currentMonthExpiryDate).toLocaleDateString('en-GB')}</p>
            </div>

            <p style="background-color: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #4caf50;">
              <strong>Note:</strong> User has been notified via email with invoice PDF attachment.
            </p>

            <div style="text-align: center; margin: 30px 0;">
              <p>Quick Actions:</p>
              <a href="${process.env.ADMIN_DASHBOARD_URL}/invoices/${invoice._id}"
                 style="display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin: 5px;">
                Mark as Paid
              </a>
              <a href="${process.env.ADMIN_DASHBOARD_URL}/orders/${order._id}"
                 style="display: inline-block; padding: 10px 20px; background-color: #2196F3; color: white; text-decoration: none; border-radius: 5px; margin: 5px;">
                View Order
              </a>
            </div>

            <p>Best regards,<br>System Notification</p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>This is an automated notification from the VA Computers billing system.</p>
          </div>
        </div>
      `
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending admin auto-renewal notification:', error);
      return false;
    }

    console.log('Admin auto-renewal notification sent successfully:', data);
    return true;
  } catch (error) {
    console.error('Error sending admin auto-renewal notification:', error);
    return false;
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
    doc.text(`Invoice Date: ${new Date(invoice.invoiceDate).toLocaleDateString('en-GB')}`, 60, boxY + 20);
    doc.text(`Due Date: ${new Date(invoice.dueDate).toLocaleDateString('en-GB')}`, 60, boxY + 40);
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
    doc.text(`Billing Period: ${new Date(invoice.renewalPeriodStart).toLocaleDateString('en-GB')} - ${new Date(invoice.renewalPeriodEnd).toLocaleDateString('en-GB')}`);
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
    doc.text(`Monthly Plan Charge (${new Date(invoice.renewalPeriodStart).toLocaleDateString('en-GB')} - ${new Date(invoice.renewalPeriodEnd).toLocaleDateString('en-GB')})`, 50, itemY)
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
      .text(`Generated on ${new Date().toLocaleString('en-GB')}`, 50, footerTop + 15, { align: 'center' });

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

/**
 * Send purchase confirmation email to admin
 * @param {Object} order - The populated order object
 * @param {Object} paymentDetails - Payment information
 * @returns {Promise<Boolean>} - Success status
 */
const sendAdminPurchaseConfirmationEmail = async (order, paymentDetails) => {
  try {
    // Admin email list
    const adminEmails = ['vacomputers.com@gmail.com', 'syncvap@gmail.com'];

    if (!order.userId || !order.productId) {
      console.warn('Order missing required customer or product information');
      return false;
    }

    const emailData = {
      from: `${process.env.FROM_NAME || 'Mera Software'} <${process.env.FROM_EMAIL}>`,
      to: adminEmails,
      subject: `🛒 New Purchase Confirmed - ${order.userId.name} - ${getOrderDisplayName(order)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">✅ New Purchase Confirmed</h1>
          </div>

          <div style="padding: 20px;">
            <p>A new order has been successfully completed!</p>

            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">Customer Information</h2>
              <p><strong>Name:</strong> ${order.userId.name}</p>
              <p><strong>Email:</strong> <a href="mailto:${order.userId.email}">${order.userId.email}</a></p>
            </div>

            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #2e7d32;">Order Details</h2>
              <p><strong>Product:</strong> ${getOrderDisplayName(order)}</p>
              <p><strong>Category:</strong> ${getOrderCategory(order, 'Service').split('_').join(' ')}</p>
              <p><strong>Quantity:</strong> ${order.quantity}</p>
              <p><strong>Total Amount:</strong> ₹${order.price.toLocaleString()}</p>
              ${order.couponApplied ? `<p><strong>Coupon:</strong> ${order.couponApplied}</p>` : ''}
              ${order.discountAmount ? `<p><strong>Discount:</strong> ₹${order.discountAmount.toLocaleString()}</p>` : ''}
            </div>

            <div style="background-color: #fff3e0; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #f57c00;">Payment Information</h2>
              <p><strong>Payment Method:</strong> ${paymentDetails.method || 'Unknown'}</p>
              <p><strong>Transaction ID:</strong> ${paymentDetails.transactionId}</p>
              ${paymentDetails.upiTransactionId ? `<p><strong>UPI Reference:</strong> ${paymentDetails.upiTransactionId}</p>` : ''}
              <p><strong>Date:</strong> ${new Date(paymentDetails.date).toLocaleString('en-IN')}</p>
            </div>

            ${order.isPartialPayment ? `
            <div style="background-color: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #2196F3;">
              <h3 style="margin-top: 0; color: #1565c0;">Installment Payment</h3>
              <p><strong>Current Payment:</strong> ₹${order.paidAmount.toLocaleString()}</p>
              <p><strong>Remaining Amount:</strong> ₹${order.remainingAmount.toLocaleString()}</p>
              <p><strong>Total Value:</strong> ₹${order.totalAmount.toLocaleString()}</p>
            </div>
            ` : ''}

            <div style="text-align: center; margin: 20px 0;">
              <a href="${process.env.ADMIN_DASHBOARD_URL}/orders/${order._id}"
                 style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                View Order Details
              </a>
            </div>

            <p>Please verify the order and process accordingly.</p>

            <p>Best regards,<br>System Notification</p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending admin purchase confirmation email:', error);
      return false;
    }

    console.log('Admin purchase confirmation email sent successfully to:', adminEmails, data);
    return true;
  } catch (error) {
    console.error('Error sending admin purchase confirmation email:', error);
    return false;
  }
};

/**
 * Send pending approval notification to admin
 * @param {Object} order - The populated order object
 * @returns {Promise<Boolean>} - Success status
 */
const sendAdminUPIPendingNotification = async (order) => {
  try {
    // Admin email list
    const adminEmails = ['vacomputers.com@gmail.com', 'syncvap@gmail.com'];

    if (!order.userId || !order.productId) {
      console.warn('Order missing required customer or product information');
      return false;
    }

    const emailData = {
      from: `${process.env.FROM_NAME || 'Mera Software'} <${process.env.FROM_EMAIL}>`,
      to: adminEmails,
      subject: `⏳ New Order Pending Approval - ${order.userId.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #FF9800; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">⏳ Order Pending Your Approval</h1>
          </div>

          <div style="padding: 20px;">
            <p>A new order has been submitted via UPI payment and is waiting for your approval.</p>

            <div style="background-color: #fff3e0; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #FF9800;">
              <h2 style="margin-top: 0; color: #e65100;">⚠️ Action Required</h2>
              <p>Please verify the payment and approve this order in the admin dashboard.</p>
            </div>

            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #333;">Customer Information</h2>
              <p><strong>Name:</strong> ${order.userId.name}</p>
              <p><strong>Email:</strong> <a href="mailto:${order.userId.email}">${order.userId.email}</a></p>
            </div>

            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h2 style="margin-top: 0; color: #2e7d32;">Order Details</h2>
              <p><strong>Product:</strong> ${getOrderDisplayName(order)}</p>
              <p><strong>Category:</strong> ${getOrderCategory(order, 'Service').split('_').join(' ')}</p>
              <p><strong>Quantity:</strong> ${order.quantity}</p>
              <p><strong>Order Amount:</strong> ₹${order.price.toLocaleString()}</p>
              ${order.couponApplied ? `<p><strong>Coupon:</strong> ${order.couponApplied}</p>` : ''}
              ${order.discountAmount ? `<p><strong>Discount:</strong> ₹${order.discountAmount.toLocaleString()}</p>` : ''}
            </div>

            ${order.isPartialPayment ? `
            <div style="background-color: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #2196F3;">
              <h3 style="margin-top: 0; color: #1565c0;">Installment Payment</h3>
              <p><strong>First Installment Amount:</strong> ₹${order.paidAmount.toLocaleString()}</p>
              <p><strong>Total Order Value:</strong> ₹${order.totalAmount.toLocaleString()}</p>
              <p><strong>Remaining After This Payment:</strong> ₹${order.remainingAmount.toLocaleString()}</p>
            </div>
            ` : ''}

            <div style="background-color: #ffe0e0; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #d32f2f;">Status</h3>
              <p><strong>Order Status:</strong> <span style="background-color: #ffebee; padding: 4px 8px; border-radius: 4px; color: #c62828;">PENDING APPROVAL</span></p>
              <p><strong>Payment Method:</strong> UPI</p>
              <p><strong>Order Date:</strong> ${new Date(order.createdAt || new Date()).toLocaleString('en-IN')}</p>
            </div>

            <div style="text-align: center; margin: 20px 0;">
              <a href="${process.env.ADMIN_DASHBOARD_URL}/transactions"
                 style="display: inline-block; padding: 12px 24px; background-color: #FF9800; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin-right: 10px;">
                Review & Approve
              </a>
              <a href="${process.env.ADMIN_DASHBOARD_URL}/orders/${order._id}"
                 style="display: inline-block; padding: 12px 24px; background-color: #2196F3; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                View Order
              </a>
            </div>

            <p>Once you approve, the customer will receive a purchase confirmation email.</p>

            <p>Best regards,<br>System Notification</p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending admin UPI pending notification:', error);
      return false;
    }

    console.log('Admin UPI pending notification sent successfully to:', adminEmails, data);
    return true;
  } catch (error) {
    console.error('Error sending admin UPI pending notification:', error);
    return false;
  }
};

/**
 * Send plan closure email to customer
 * @param {Object} order - The populated order object
 * @param {String} closureReason - Reason for plan closure
 * @param {Date} closedDate - Date when plan was closed
 * @returns {Promise<Boolean>} - Success status
 */
const sendPlanClosureEmailToCustomer = async (order, closureReason, closedDate) => {
  try {
    if (!order.userId || !order.userId.email) {
      console.warn('Order missing customer information');
      return false;
    }

    const emailData = {
      from: `${process.env.FROM_NAME || 'Mera Software'} <${process.env.FROM_EMAIL}>`,
      to: [order.userId.email],
      subject: '❌ Your Website Update Plan Has Been Closed',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #e74c3c; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Plan Closure Notice</h1>
          </div>

          <div style="padding: 20px;">
            <p>Hello ${order.userId.name},</p>

            <p>We are writing to inform you that your website update plan has been closed.</p>

            <div style="background-color: #ffe0e0; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e74c3c;">
              <h3 style="margin-top: 0; color: #c62828;">Plan Details</h3>
              <p><strong>Plan Name:</strong> ${order.productId?.serviceName || 'Website Update Plan'}</p>
              <p><strong>Closure Date:</strong> ${new Date(closedDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
              <p><strong>Closure Reason:</strong> ${closureReason}</p>
              <p><strong>Status:</strong> <span style="color: #e74c3c; font-weight: bold;">CLOSED ❌</span></p>
            </div>

            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4caf50;">
              <h3 style="margin-top: 0; color: #2e7d32;">✅ Important - Your Data is Safe</h3>
              <ul style="margin: 10px 0; padding-left: 20px; color: #555;">
                <li>All your previous updates are preserved</li>
                <li>You can view your complete update history anytime</li>
                <li>All files are securely stored in your dashboard</li>
                <li>You can download any previous work you need</li>
              </ul>
            </div>

            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #333;">Need Help?</h3>
              <p style="margin: 5px 0;">If you have any questions about your plan closure or need to reopen your plan, please contact our support team:</p>
              <p style="margin: 10px 0;">
                <strong>📧 Email:</strong> contact@merasoftware.com<br>
                <strong>📱 Phone:</strong> +91 92565 37003
              </p>
            </div>

            <p style="color: #666; font-size: 14px; margin-top: 20px;">
              You can log into your dashboard anytime to view your complete update history and access your files.
            </p>

            <p style="margin-top: 20px;">Best regards,<br><strong>Mera Software Team</strong></p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666; border-top: 1px solid #ddd; margin-top: 20px;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending plan closure email to customer:', error);
      return false;
    }

    console.log('Plan closure email sent successfully to customer:', order.userId.email, data);
    return true;
  } catch (error) {
    console.error('Error sending plan closure email to customer:', error);
    return false;
  }
};

/**
 * Send plan closure email to admin
 * @param {Object} order - The populated order object
 * @param {String} closureReason - Reason for plan closure
 * @param {String} closedByAdmin - Admin name who closed the plan
 * @param {Date} closedDate - Date when plan was closed
 * @returns {Promise<Boolean>} - Success status
 */
const sendPlanClosureEmailToAdmin = async (order, closureReason, closedByAdmin, closedDate) => {
  try {
    const adminEmails = ['vacomputers.com@gmail.com', 'syncvap@gmail.com'];

    if (!order.userId || !order.productId) {
      console.warn('Order missing required customer or product information');
      return false;
    }

    const emailData = {
      from: `${process.env.FROM_NAME || 'Mera Software'} <${process.env.FROM_EMAIL}>`,
      to: adminEmails,
      subject: `🔔 Plan Closed - ${order.userId.name} - ${order.productId.serviceName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #FF9800; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Plan Closure Alert</h1>
          </div>

          <div style="padding: 20px;">
            <p>A customer's update plan has been closed.</p>

            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #333;">Customer Information</h3>
              <p><strong>Name:</strong> ${order.userId.name}</p>
              <p><strong>Email:</strong> <a href="mailto:${order.userId.email}">${order.userId.email}</a></p>
              <p><strong>Customer ID:</strong> ${order.userId._id}</p>
            </div>

            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #2e7d32;">Plan Information</h3>
              <p><strong>Plan Name:</strong> ${order.productId.serviceName}</p>
              <p><strong>Plan Type:</strong> ${
                order.productId?.isMonthlyLimitedPlan
                  ? 'Monthly Limited Plan'
                  : order.productId?.isMonthlyRenewablePlan
                    ? 'Yearly Renewable Plan'
                    : 'Regular Update Plan'
              }</p>
              <p><strong>Created Date:</strong> ${new Date(order.createdAt).toLocaleDateString('en-GB')}</p>
              <p><strong>Closure Date:</strong> ${new Date(closedDate).toLocaleDateString('en-GB')}</p>
              <p><strong>Status:</strong> <span style="background-color: #ffebee; color: #c62828; padding: 4px 8px; border-radius: 4px;">CLOSED ❌</span></p>
            </div>

            <div style="background-color: #fff3e0; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #FF9800;">
              <h3 style="margin-top: 0; color: #e65100;">Closure Details</h3>
              <p><strong>Reason:</strong> ${closureReason}</p>
              <p><strong>Closed By:</strong> ${closedByAdmin}</p>
              <p><strong>Updates Used:</strong> ${order.updatesUsed || 0}/${order.productId?.updateCount || 'N/A'}</p>
            </div>

            <div style="background-color: #ffe0e0; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e74c3c;">
              <h3 style="margin-top: 0; color: #c62828;">Action Items</h3>
              <ul style="margin: 10px 0; padding-left: 20px;">
                <li>☐ Verify closure was intended</li>
                <li>☐ Check if refund is applicable</li>
                <li>☐ Process refund if needed</li>
                <li>☐ Document closure reason in CRM</li>
              </ul>
            </div>

            <div style="text-align: center; margin: 20px 0;">
              <p style="color: #666; font-size: 14px;">
                Customer has been notified via email. All plan data and update history has been preserved.
              </p>
            </div>

            <p style="margin-top: 20px;">This is an automated notification.</p>
          </div>

          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 12px; color: #666; border-top: 1px solid #ddd; margin-top: 20px;">
            <p>© ${new Date().getFullYear()} Mera Software. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const { data, error } = await resend.emails.send(emailData);

    if (error) {
      console.error('Error sending plan closure email to admin:', error);
      return false;
    }

    console.log('Plan closure email sent successfully to admin:', adminEmails, data);
    return true;
  } catch (error) {
    console.error('Error sending plan closure email to admin:', error);
    return false;
  }
};

module.exports = {
  sendUpdateRequestNotification,
  sendUserConfirmation,
  sendDeveloperAssignedNotification,
  sendUpdateCompletedNotification,
  sendDeveloperAssignmentEmail,
  // Purchase related exports
  sendPurchaseConfirmationEmail,
  sendMonthlyLimitedPlanActivationEmail,
  generateInvoicePdf,
  // Admin purchase notifications
  sendAdminPurchaseConfirmationEmail,
  sendAdminUPIPendingNotification,
  // Plan closure emails
  sendPlanClosureEmailToCustomer,
  sendPlanClosureEmailToAdmin,
  // Wallet related exports
  sendWalletRechargeConfirmationEmail,
  sendPaymentRejectionEmail,
  sendProjectCancellationEmail,
  sendWalletRechargeRejectionEmail,
  // Contact form exports
  sendContactFormConfirmation,
  sendContactRequestNotification,
  // Callback form exports
  sendCallbackConfirmation,
  sendCallbackRequestNotification,
  // Project related exports
  sendProjectUpdateEmail,
  sendProjectMessageEmail,
  // Monthly billing exports
  sendMonthlyInvoiceEmail,
  sendAdminAutoRenewalNotification,
  generateMonthlyInvoicePdf
};
