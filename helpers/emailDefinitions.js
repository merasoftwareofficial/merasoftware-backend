// Every email action's built-in template, in one place: its original wording, the details
// (variables) an editor may insert with a label, hint and sample, its sections (blocks), and
// build(), which turns the action's business data into those values. emailTemplates.js copies
// the wording once into the database as the action's editable "Standard" template; the copy
// here stays the original for "Reset to original". Values are strings; an empty value drops
// its whole line from the mail (emailMarkup.render), so optional details need no logic here.
const { formatIndiaDate, formatIndiaDateTime } = require('./dateTime');
const { getOrderDisplayName, getOrderCategory } = require('./orderPresentation');
const { tableBlock, listBlock } = require('./emailMarkup');

const ADMIN_EMAILS = ['vacomputers.com@gmail.com', 'syncvap@gmail.com'];
const money = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
const text = value => (value === undefined || value === null ? '' : String(value));
const day = (value, options) => (value ? formatIndiaDate(value, options) : '');
const moment = value => (value ? formatIndiaDateTime(value) : '');
const link = (base, path) => (base ? `${String(base).replace(/\/+$/, '')}${path}` : '');
const adminLink = path => link(process.env.ADMIN_DASHBOARD_URL, path);
const list = value => (Array.isArray(value) ? value : [value]).filter(Boolean);
const lines = (...rows) => rows.join('\n');
const detail = (label, sample, hint) => ({ label, sample, ...(hint ? { hint } : {}) });
const SIGN_OFF = ['Best regards,', 'Mera Software Team'];
const SYSTEM_SIGN_OFF = ['Best regards,', 'System Notification'];
const REFUND_METHODS = { wallet: 'Wallet', upi: 'UPI', cash: 'Cash', bank_transfer: 'Bank Transfer', cheque: 'Cheque', combined: 'Combined', demo: 'Demo Credit' };

function refundTable(refunds) {
  const rows = refunds.map(entry => [
    REFUND_METHODS[entry.method] || entry.method || 'Refund',
    money(entry.amount),
    entry.method === 'wallet' ? 'Credited to your wallet' : `Reference: ${entry.referenceId || 'N/A'}`,
  ]);
  const total = refunds.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  return tableBlock('Refund Details', rows, ['Total Refunded', money(total), '']);
}
/** An instruction list, or the line the old mail showed when there were none. */
const instructionList = (title, instructions) => listBlock(title, (instructions || []).map(item => text(item?.text)).filter(Boolean).concat(instructions?.length ? [] : ['No instructions provided']));
/** The [[Text||URL]] buttons admins type in project messages, as plain "Text: URL". */
const plainButtons = message => text(message).replace(/\[\[(.+?)\|\|(.+?)\]\]/g, (_, label, url) => {
  const target = url.trim();
  return `${label.trim()}: ${/^https?:\/\//.test(target) ? target : `https://${target}`}`;
});
// Update requests belong to a plan or a client project; both name themselves the same way.
const planName = updateRequest => getOrderDisplayName(updateRequest?.updatePlanId, 'Website plan');
// The category name frozen on the project (helpers/projectCategories.js); plans fall back to their key.
const category = order => order?.projectSnapshot?.categoryLabel || getOrderCategory(order, 'Service').split('_').join(' ');
const planType = product => (product?.isMonthlyLimitedPlan ? 'Monthly Limited Plan' : product?.isMonthlyRenewablePlan ? 'Yearly Renewable Plan' : 'Regular Update Plan');

// Details several actions share; the same key always means the same thing.
const NAME = detail('Customer name', 'Ravi Kumar', 'Filled with the customer’s name when the mail is prepared');
const CUSTOMER_NAME = detail('Customer name', 'Ravi Kumar');
const CUSTOMER_EMAIL = detail('Customer email', 'ravi@example.com');
const PLAN = detail('Plan name', 'Website Care Plan');
const PRODUCT = detail('Product or project name', 'Business Website');
const DEVELOPER = detail('Developer name', 'Aman Singh');
const PROJECT = detail('Project name', 'Business Website');
const INVOICE_NUMBER = detail('Invoice number', 'INV-1001');

const definitions = {
  // --- Leads ------------------------------------------------------------------------------
  'lead.created': {
    subject: 'Welcome to Mera Software',
    text: lines('Hello {{name}},', '', 'Thank you for connecting with Mera Software. Our team will contact you to discuss your requirements.', '', ...SIGN_OFF),
    variables: { name: detail('Lead name', 'Ravi Kumar', 'Filled with the lead’s name from the lead form') },
    blocks: {},
    build(name, email) {
      return email ? { to: [email], values: { name: text(name) } } : null;
    },
  },
  sendClientAccountCreatedEmail: {
    subject: 'Welcome to Mera Software — your client account is ready',
    text: lines(
      'Hello {{name}},', '',
      'You have been added as a client of Mera Software. Your client account is ready, and from now on you can follow your projects, payments and updates from one place.', '',
      '**Login email:** {{email}}', '**Login here:** {{loginLink}}', '',
      'If you have any questions, simply reply to this email.', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME,
      email: detail('Login email', 'ravi@example.com', 'The email address the client logs in with'),
      loginLink: detail('Login link', 'https://portal.example.com/login', 'The client portal’s login page'),
    },
    blocks: {},
    build(user) {
      if (!user?.email) return null;
      return { to: [user.email], values: { name: text(user.name), email: user.email, loginLink: link(process.env.FORNTEND_URL, '/login') } };
    },
  },

  // --- Updates ----------------------------------------------------------------------------
  sendUpdateRequestNotification: {
    subject: 'New Website Update Request Submitted',
    text: lines(
      'A customer has submitted a new website update request.', '',
      '**Client:** {{customerName}} ({{customerEmail}})', '**Plan:** {{plan}}', '**Files:** {{files}}', '',
      '{{instructions}}', '',
      'Please log into the admin dashboard to view the complete details and assign a developer.',
      '**View request:** {{requestsLink}}',
    ),
    variables: {
      customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL, plan: PLAN,
      files: detail('Files', '2 file(s) uploaded', 'How many files the customer uploaded'),
      requestsLink: detail('Update requests link', 'https://admin.example.com/update-requests', 'The admin dashboard’s update request list'),
    },
    blocks: { instructions: { label: 'Instructions', hint: 'The customer’s instructions as a list', sample: () => listBlock('Instructions', ['Change the banner photo', 'Update the phone number']) } },
    build(updateRequest, adminEmails) {
      const to = list(adminEmails);
      if (!to.length) return null;
      const files = updateRequest?.files?.length;
      return {
        to,
        values: {
          customerName: text(updateRequest?.userId?.name), customerEmail: text(updateRequest?.userId?.email), plan: planName(updateRequest),
          files: files ? `${files} file(s) uploaded` : 'No files uploaded', requestsLink: adminLink('/update-requests'),
        },
        blocks: { instructions: instructionList('Instructions', updateRequest?.instructions) },
      };
    },
  },
  sendUserConfirmation: {
    subject: 'Your Website Update Request Has Been Received',
    text: lines(
      'Hello {{name}},', '',
      'We have received your website update request for your **{{plan}}** plan.', '',
      'Our team will review your request and start working on it as soon as possible. You will receive notifications when there are updates or when your request has been completed.', '',
      'Thank you for your business!', '',
      ...SIGN_OFF,
    ),
    variables: { name: NAME, plan: PLAN },
    blocks: {},
    build(updateRequest) {
      const user = updateRequest?.userId;
      return user?.email ? { to: [user.email], values: { name: text(user.name), plan: planName(updateRequest) } } : null;
    },
  },
  sendDeveloperAssignedNotification: {
    subject: 'A Developer Has Been Assigned to Your Work',
    text: lines(
      'Hello {{name}},', '',
      'We are pleased to inform you that a developer has been assigned to your {{work}}.', '',
      '**Project:** {{project}}', '**Developer:** {{developer}}', '',
      'Your work is now in progress, and you will receive further updates as it proceeds.', '',
      'Thank you for your patience!', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME,
      work: detail('Work type', 'website project', '“website project” or “website update request”'),
      project: detail('Project name', 'Business Website', 'Empty for an update request'),
      developer: DEVELOPER,
    },
    blocks: {},
    build(entity, type = 'update') {
      const user = entity?.userId;
      if (!user?.email) return null;
      const isProject = type === 'project';
      return { to: [user.email], values: {
        name: text(user.name), work: isProject ? 'website project' : 'website update request',
        project: isProject ? getOrderDisplayName(entity, 'Project') : '', developer: text(entity?.assignedDeveloper?.name),
      } };
    },
  },
  sendUpdateCompletedNotification: {
    subject: 'Your Website Update Has Been Completed',
    text: lines(
      'Hello {{name}},', '',
      'We are happy to inform you that your website update request for **{{plan}}** has been completed successfully.', '',
      'Please take some time to review the changes. If you have any questions or need any adjustments, please let us know.', '',
      'Thank you for choosing our service!', '',
      ...SIGN_OFF,
    ),
    variables: { name: NAME, plan: PLAN },
    blocks: {},
    build(updateRequest) {
      const user = updateRequest?.userId;
      return user?.email ? { to: [user.email], values: { name: text(user.name), plan: planName(updateRequest) } } : null;
    },
  },
  sendDeveloperAssignmentEmail: {
    subject: 'New Work Assigned to You',
    text: lines(
      'Hello {{developer}},', '',
      'You have been assigned to work on a {{work}}.', '',
      '**Client:** {{customerName}} ({{customerEmail}})', '**Service:** {{service}}', '',
      '{{instructions}}', '',
      'Please log into your developer dashboard to view the complete details and start working.',
      '**View assignment:** {{dashboardLink}}',
    ),
    variables: {
      developer: DEVELOPER,
      work: detail('Work type', 'website project', '“website project” or “website update request”'),
      customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL,
      service: detail('Service', 'Business Website'),
      dashboardLink: detail('Developer dashboard link', 'https://developer.example.com/developer-projects'),
    },
    blocks: { instructions: { label: 'Client instructions', hint: 'Only for an update request; left out for a project', sample: () => listBlock('Client Instructions', ['Change the banner photo']) } },
    build(entity, type = 'update') {
      const developer = entity?.assignedDeveloper;
      if (!developer?.email) return null;
      const isProject = type === 'project';
      return {
        to: [developer.email],
        values: {
          developer: text(developer.name), work: isProject ? 'website project' : 'website update request',
          customerName: text(entity?.userId?.name), customerEmail: text(entity?.userId?.email),
          service: isProject ? getOrderDisplayName(entity, 'Project') : planName(entity),
          dashboardLink: link(process.env.DEVELOPER_DASHBOARD_URL, isProject ? '/developer-projects' : '/developer-update-requests'),
        },
        blocks: { instructions: isProject ? listBlock('', []) : instructionList('Client Instructions', entity?.instructions) },
      };
    },
  },

  // --- Orders and plans ---------------------------------------------------------------------
  sendPurchaseConfirmationEmail: {
    subject: 'Thank You for Your Purchase!',
    text: lines(
      'Hello {{name}},', '',
      'Thank you for your purchase! We are excited to confirm your order details.', '',
      '## Order Details',
      '**Product:** {{product}}', '**Category:** {{category}}', '**Quantity:** {{quantity}}',
      '**Original Price:** {{originalPrice}}', '**Coupon Applied:** {{coupon}}', '**Discount:** {{discount}}',
      '**Final Price:** {{finalPrice}}', '**Payment Method:** {{paymentMethod}}', '',
      '**Installment paid now:** {{paidNow}}', '**Remaining amount:** {{remaining}}', '**Total value:** {{totalValue}}', '',
      'We have attached an invoice to this email for your records.', '',
      'If you have any questions about your purchase, please do not hesitate to contact our support team.', '',
      'Thank you for choosing our services!', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME, product: PRODUCT, category: detail('Category', 'Website Development'), quantity: detail('Quantity', '1'),
      originalPrice: detail('Original price', '₹25,000'), coupon: detail('Coupon', 'DIWALI10', '“None” when no coupon was used'),
      discount: detail('Discount', '₹2,500', 'Empty when there is no discount'), finalPrice: detail('Final price', '₹22,500'),
      paymentMethod: detail('Payment method', 'Wallet'),
      paidNow: detail('Installment paid now', '₹11,250', 'Only for an installment plan'),
      remaining: detail('Remaining amount', '₹11,250', 'Only for an installment plan'),
      totalValue: detail('Total value', '₹22,500', 'Only for an installment plan'),
    },
    blocks: {},
    build(order, paymentDetails = {}) {
      const user = order?.userId;
      if (!user?.email) return null;
      const partial = !!order.isPartialPayment;
      return {
        to: [user.email],
        values: {
          name: text(user.name), product: getOrderDisplayName(order), category: category(order), quantity: text(order.quantity),
          originalPrice: money(order.originalPrice || order.price), coupon: text(order.couponApplied || 'None'),
          discount: order.discountAmount > 0 ? money(order.discountAmount) : '', finalPrice: money(order.price),
          paymentMethod: text(paymentDetails?.method || 'Wallet'),
          paidNow: partial ? money(order.paidAmount) : '', remaining: partial ? money(order.remainingAmount) : '', totalValue: partial ? money(order.totalAmount) : '',
        },
        attachments: paymentDetails?.invoiceBuffer ? [{ filename: `Invoice-${order._id}.pdf`, content: paymentDetails.invoiceBuffer }] : [],
      };
    },
  },
  sendMonthlyLimitedPlanActivationEmail: {
    subject: '🎉 1 Year Plan Activated - Monthly Limited Update Plan',
    text: lines(
      'Hello {{name}},', '',
      'Congratulations! Your **1 Year Website Update Plan** is now **ACTIVE**.', '',
      '## Your Plan Details',
      '**Plan Name:** {{plan}}', '**Plan Duration:** 1 Year (12 Months)', '**Monthly Updates:** 1 Update Per Month',
      '**Monthly Renewal Cost:** {{monthlyPrice}}', '**Activation Date:** {{activatedOn}}', '',
      '## How Your Auto-Renewal Works',
      '- Your plan will automatically renew every month for the next 12 months',
      '- You will receive 1 website update per month',
      '- Monthly billing of {{monthlyPrice}} will be sent at the end of each month',
      '- Your plan remains active even if payment is pending',
      '- Updates will be processed after payment confirmation', '',
      '## Plan Upgrade Policy',
      'If you wish to **upgrade your plan** to a higher tier, please inform us at least **24 working hours before your next renewal date**. This ensures a smooth transition without any service interruption.', '',
      '## What’s Next?',
      '- Login to your dashboard to submit your monthly update requests',
      '- Track your plan status and remaining days',
      '- View and download your monthly invoices',
      '- Contact us anytime for support or upgrades', '',
      '## Need Help? Contact Us',
      '**Email:** contact@merasoftware.com', '**Phone:** +91 92565 37003', '**Office:** VA Computers, Near New Bus Stand, Majitha, 143601',
      '**UPI:** vacomputers.com@okhdfcbank', '',
      'We have attached your **paid invoice** to this email for your records.', '',
      'Thank you for choosing **VA Computers**! We are committed to providing you with the best service.', '',
      ...SIGN_OFF, 'Your Digital Partner',
    ),
    variables: {
      name: NAME, plan: PLAN,
      monthlyPrice: detail('Monthly renewal cost', '₹3,000'),
      activatedOn: detail('Activation date', '17 October 2026'),
    },
    blocks: {},
    build(order, paymentDetails = {}) {
      const user = order?.userId;
      if (!user?.email) return null;
      return {
        to: [user.email],
        values: {
          name: text(user.name), plan: getOrderDisplayName(order, 'Website Update Plan'),
          monthlyPrice: money(order.productId?.monthlyRenewalPrice || 3000), activatedOn: day(Date.now(), { day: 'numeric', month: 'long', year: 'numeric' }),
        },
        attachments: paymentDetails?.invoiceBuffer ? [{ filename: `Invoice-${order._id}.pdf`, content: paymentDetails.invoiceBuffer }] : [],
      };
    },
  },
  sendAdminPurchaseConfirmationEmail: {
    subject: '🛒 New Purchase Confirmed - {{customerName}} - {{product}}',
    text: lines(
      'A new order has been successfully completed!', '',
      '## Customer Information', '**Name:** {{customerName}}', '**Email:** {{customerEmail}}', '',
      '## Order Details', '**Product:** {{product}}', '**Category:** {{category}}', '**Quantity:** {{quantity}}',
      '**Total Amount:** {{total}}', '**Coupon:** {{coupon}}', '**Discount:** {{discount}}', '',
      '## Payment Information', '**Payment Method:** {{paymentMethod}}', '**Transaction ID:** {{transactionId}}',
      '**UPI Reference:** {{upiReference}}', '**Date:** {{paidOn}}', '',
      '**Installment paid now:** {{paidNow}}', '**Remaining amount:** {{remaining}}', '**Total value:** {{totalValue}}', '',
      '**View order:** {{orderLink}}', '',
      'Please verify the order and process accordingly.', '',
      ...SYSTEM_SIGN_OFF,
    ),
    variables: {
      customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL, product: PRODUCT, category: detail('Category', 'Website Development'),
      quantity: detail('Quantity', '1'), total: detail('Total amount', '₹22,500'),
      coupon: detail('Coupon', 'DIWALI10', 'Empty when no coupon was used'), discount: detail('Discount', '₹2,500', 'Empty when there is no discount'),
      paymentMethod: detail('Payment method', 'UPI'), transactionId: detail('Transaction ID', 'TXN-1001'),
      upiReference: detail('UPI reference', 'UPI123456', 'Empty when not paid by UPI'), paidOn: detail('Payment date and time', '17 Oct 2026, 11:30 am IST'),
      paidNow: detail('Installment paid now', '₹11,250', 'Only for an installment plan'),
      remaining: detail('Remaining amount', '₹11,250', 'Only for an installment plan'),
      totalValue: detail('Total value', '₹22,500', 'Only for an installment plan'),
      orderLink: detail('Order link', 'https://admin.example.com/orders/123', 'The order in the admin dashboard'),
    },
    blocks: {},
    build(order, paymentDetails = {}) {
      if (!order?.userId || !order?.productId) return null;
      const partial = !!order.isPartialPayment;
      return {
        to: ADMIN_EMAILS,
        values: {
          customerName: text(order.userId.name), customerEmail: text(order.userId.email), product: getOrderDisplayName(order), category: category(order),
          quantity: text(order.quantity), total: money(order.price), coupon: text(order.couponApplied), discount: order.discountAmount ? money(order.discountAmount) : '',
          paymentMethod: text(paymentDetails?.method || 'Unknown'), transactionId: text(paymentDetails?.transactionId),
          upiReference: text(paymentDetails?.upiTransactionId), paidOn: moment(paymentDetails?.date),
          paidNow: partial ? money(order.paidAmount) : '', remaining: partial ? money(order.remainingAmount) : '', totalValue: partial ? money(order.totalAmount) : '',
          orderLink: adminLink(`/orders/${order._id}`),
        },
      };
    },
  },
  sendPlanClosureEmailToCustomer: {
    subject: '❌ Your Website Update Plan Has Been Closed',
    text: lines(
      'Hello {{name}},', '',
      'We are writing to inform you that your website update plan has been closed.', '',
      '## Plan Details', '**Plan Name:** {{plan}}', '**Closure Date:** {{closedOn}}', '**Closure Reason:** {{reason}}', '**Status:** CLOSED', '',
      '## Your Data is Safe',
      '- All your previous updates are preserved',
      '- You can view your complete update history anytime',
      '- All files are securely stored in your dashboard',
      '- You can download any previous work you need', '',
      '## Need Help?',
      'If you have any questions about your plan closure or need to reopen your plan, please contact our support team:',
      '**Email:** contact@merasoftware.com', '**Phone:** +91 92565 37003', '',
      'You can log into your dashboard anytime to view your complete update history and access your files.', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME, plan: PLAN, closedOn: detail('Closure date', '17 October 2026'),
      reason: detail('Closure reason', 'Requested by the customer', 'Empty when no reason was given'),
    },
    blocks: {},
    build(order, closureReason, closedDate) {
      const user = order?.userId;
      if (!user?.email) return null;
      return { to: [user.email], values: {
        name: text(user.name), plan: getOrderDisplayName(order, 'Website Update Plan'),
        closedOn: day(closedDate, { day: 'numeric', month: 'long', year: 'numeric' }), reason: text(closureReason),
      } };
    },
  },
  sendPlanClosureEmailToAdmin: {
    subject: '🔔 Plan Closed - {{customerName}} - {{plan}}',
    text: lines(
      'A customer’s update plan has been closed.', '',
      '## Customer Information', '**Name:** {{customerName}}', '**Email:** {{customerEmail}}', '**Customer ID:** {{customerId}}', '',
      '## Plan Information', '**Plan Name:** {{plan}}', '**Plan Type:** {{planType}}', '**Created Date:** {{createdOn}}', '**Closure Date:** {{closedOn}}', '**Status:** CLOSED', '',
      '## Closure Details', '**Reason:** {{reason}}', '**Closed By:** {{closedBy}}', '**Updates Used:** {{updatesUsed}}', '',
      '## Action Items',
      '- Verify closure was intended',
      '- Check if refund is applicable',
      '- Process refund if needed',
      '- Document closure reason in CRM', '',
      'The customer has been notified via email. All plan data and update history has been preserved.', '',
      'This is an automated notification.',
    ),
    variables: {
      customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL, customerId: detail('Customer ID', '64f0c0ffee1234567890abcd'),
      plan: PLAN, planType: detail('Plan type', 'Monthly Limited Plan'), createdOn: detail('Created date', '1 Jan 2026'),
      closedOn: detail('Closure date', '17 Oct 2026'), reason: detail('Closure reason', 'Requested by the customer'),
      closedBy: detail('Closed by', 'Admin'), updatesUsed: detail('Updates used', '3/12'),
    },
    blocks: {},
    build(order, closureReason, closedByAdmin, closedDate) {
      if (!order?.userId || !order?.productId) return null;
      return { to: ADMIN_EMAILS, values: {
        customerName: text(order.userId.name), customerEmail: text(order.userId.email), customerId: text(order.userId._id),
        plan: getOrderDisplayName(order, 'Website Update Plan'), planType: planType(order.productId), createdOn: day(order.createdAt), closedOn: day(closedDate),
        reason: text(closureReason), closedBy: text(closedByAdmin), updatesUsed: `${order.updatesUsed || 0}/${order.productId?.updateCount || 'N/A'}`,
      } };
    },
  },

  // --- Payments and wallet ------------------------------------------------------------------
  sendAdminUPIPendingNotification: {
    subject: '⏳ New Order Pending Approval - {{customerName}}',
    text: lines(
      'A new order has been submitted via UPI payment and is waiting for your approval.', '',
      '**Action required:** please verify the payment and approve this order in the admin dashboard.', '',
      '## Customer Information', '**Name:** {{customerName}}', '**Email:** {{customerEmail}}', '',
      '## Order Details', '**Product:** {{product}}', '**Category:** {{category}}', '**Quantity:** {{quantity}}',
      '**Order Amount:** {{total}}', '**Coupon:** {{coupon}}', '**Discount:** {{discount}}', '',
      '**First installment amount:** {{paidNow}}', '**Total order value:** {{totalValue}}', '**Remaining after this payment:** {{remaining}}', '',
      '## Status', '**Order Status:** PENDING APPROVAL', '**Payment Method:** UPI', '**Order Date:** {{orderedOn}}', '',
      '**Review & approve:** {{approveLink}}', '**View order:** {{orderLink}}', '',
      'Once you approve, the customer will receive a purchase confirmation email.', '',
      ...SYSTEM_SIGN_OFF,
    ),
    variables: {
      customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL, product: PRODUCT, category: detail('Category', 'Website Development'),
      quantity: detail('Quantity', '1'), total: detail('Order amount', '₹22,500'),
      coupon: detail('Coupon', 'DIWALI10', 'Empty when no coupon was used'), discount: detail('Discount', '₹2,500', 'Empty when there is no discount'),
      paidNow: detail('First installment amount', '₹11,250', 'Only for an installment plan'),
      totalValue: detail('Total order value', '₹22,500', 'Only for an installment plan'),
      remaining: detail('Remaining after this payment', '₹11,250', 'Only for an installment plan'),
      orderedOn: detail('Order date and time', '17 Oct 2026, 11:30 am IST'),
      approveLink: detail('Approval link', 'https://admin.example.com/transactions', 'The transactions page in the admin dashboard'),
      orderLink: detail('Order link', 'https://admin.example.com/orders/123', 'The order in the admin dashboard'),
    },
    blocks: {},
    build(order) {
      if (!order?.userId || !order?.productId) return null;
      const partial = !!order.isPartialPayment;
      return { to: ADMIN_EMAILS, values: {
        customerName: text(order.userId.name), customerEmail: text(order.userId.email), product: getOrderDisplayName(order), category: category(order),
        quantity: text(order.quantity), total: money(order.price), coupon: text(order.couponApplied), discount: order.discountAmount ? money(order.discountAmount) : '',
        paidNow: partial ? money(order.paidAmount) : '', totalValue: partial ? money(order.totalAmount) : '', remaining: partial ? money(order.remainingAmount) : '',
        orderedOn: moment(order.createdAt || new Date()), approveLink: adminLink('/transactions'), orderLink: adminLink(`/orders/${order._id}`),
      } };
    },
  },
  sendWalletRechargeConfirmationEmail: {
    subject: 'Wallet Recharge Confirmation',
    text: lines(
      'Hello {{name}},', '',
      'We are pleased to confirm that your wallet has been successfully recharged!', '',
      '## Recharge Details', '**Transaction ID:** {{transactionId}}', '**Amount:** {{amount}}', '**Date:** {{paidOn}}',
      '**Payment Method:** {{paymentMethod}}', '**UPI Reference:** {{upiReference}}', '',
      'Your updated wallet balance is now reflected in your account.', '',
      'If you have any questions about this transaction, please contact our support team.', '',
      'Thank you for choosing our services!', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME, transactionId: detail('Transaction ID', 'TXN-1001'), amount: detail('Amount', '₹5,000'),
      paidOn: detail('Date and time', '17 Oct 2026, 11:30 am IST'), paymentMethod: detail('Payment method', 'UPI'),
      upiReference: detail('UPI reference', 'UPI123456', 'Empty when not paid by UPI'),
    },
    blocks: {},
    build(user, transaction = {}) {
      if (!user?.email) return null;
      return { to: [user.email], values: {
        name: text(user.name), transactionId: text(transaction.transactionId), amount: money(transaction.amount), paidOn: moment(transaction.date),
        paymentMethod: text(transaction.paymentMethod || 'UPI'), upiReference: text(transaction.upiTransactionId),
      } };
    },
  },
  sendPaymentRejectionEmail: {
    subject: 'Order Payment Rejected',
    text: lines(
      'Hello {{name}},', '',
      'We regret to inform you that your payment for the following order has been rejected.', '',
      '## Order Details', '**Product:** {{product}}', '**Transaction ID:** {{transactionId}}', '**Amount:** {{amount}}', '**Date:** {{paidOn}}', '',
      '**Reason for rejection:** {{reason}}', '',
      'Please make a new payment if you wish to complete your transaction. If you believe this is an error, please contact our support team.', '',
      'Thank you for your understanding.', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME, product: PRODUCT, transactionId: detail('Transaction ID', 'TXN-1001'), amount: detail('Amount', '₹5,000'),
      paidOn: detail('Payment date and time', '17 Oct 2026, 11:30 am IST'), reason: detail('Rejection reason', 'Payment not received', 'Empty when no reason was given'),
    },
    blocks: {},
    build(user, transaction = {}, order, rejectionReason) {
      if (!user?.email) return null;
      return { to: [user.email], values: {
        name: text(user.name), product: order ? getOrderDisplayName(order) : '', transactionId: text(transaction.transactionId),
        amount: money(transaction.amount), paidOn: moment(transaction.date), reason: text(rejectionReason),
      } };
    },
  },
  sendWalletRechargeRejectionEmail: {
    subject: 'Wallet Recharge Rejected',
    text: lines(
      'Hello {{name}},', '',
      'We regret to inform you that your wallet recharge transaction has been rejected.', '',
      '## Transaction Details', '**Transaction ID:** {{transactionId}}', '**Amount:** {{amount}}', '**Date:** {{paidOn}}', '',
      '**Reason for rejection:** {{reason}}', '',
      'Please make a new payment if you wish to complete your transaction. If you believe this is an error, please contact our support team.', '',
      'Thank you for your understanding.', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME, transactionId: detail('Transaction ID', 'TXN-1001'), amount: detail('Amount', '₹5,000'),
      paidOn: detail('Payment date and time', '17 Oct 2026, 11:30 am IST'), reason: detail('Rejection reason', 'Payment not received', 'Empty when no reason was given'),
    },
    blocks: {},
    build(user, transaction = {}, rejectionReason) {
      if (!user?.email) return null;
      return { to: [user.email], values: {
        name: text(user.name), transactionId: text(transaction.transactionId), amount: money(transaction.amount),
        paidOn: moment(transaction.date), reason: text(rejectionReason),
      } };
    },
  },

  // --- Projects -----------------------------------------------------------------------------
  sendProjectCreatedEmail: {
    subject: 'Your Project Has Started',
    text: lines(
      'Hello {{name}},', '',
      'We have created your project and work has begun. The details are below.', '',
      '## Project Details',
      '**Project:** {{project}}', '**Price:** {{price}}', '**Offer:** {{offer}}', '**Started On:** {{startedOn}}', '',
      '## Payment',
      '{{paymentPlan}}', '**Received so far:** {{receivedSoFar}}', '**Due now:** {{dueNow}}', '',
      "You can follow your project's progress from your account at any time.", '',
      ...SIGN_OFF,
    ),
    variables: {
      name: detail('Customer name', 'Ravi Kumar'),
      project: PROJECT,
      price: detail('Price', '₹25,000', 'The amount, or FREE'),
      offer: detail('Offer title', 'Diwali Offer', 'Empty when the project has no offer'),
      startedOn: detail('Start date and time', '17 Oct 2026, 11:30 am'),
      paymentPlan: detail('Payment plan', 'Payable in 2 installments: ₹12,500 + ₹12,500.', 'One sentence: free, one-time or installments'),
      receivedSoFar: detail('Amount received', '', 'Empty when nothing is paid yet'),
      dueNow: detail('Amount due now', '₹12,500 (invoice INV-1001)', 'With the invoice number; empty when free or already paid'),
    },
    blocks: {},
    build(user, order, invoice) {
      if (!user?.email) return null;
      const total = Number(order.totalAmount || order.price || 0);
      const isFree = total === 0;
      const installments = Array.isArray(order.installments) ? order.installments : [];
      const paidNow = Number(order.paidAmount || 0);
      let paymentPlan = `One-time payment of ${money(total)}.`;
      if (isFree) paymentPlan = 'This project is FREE — nothing is due.';
      else if (order.isPartialPayment && installments.length) paymentPlan = `Payable in ${installments.length} installments: ${installments.map(item => money(item.amount)).join(' + ')}.`;
      const due = `${money(invoice?.amount ?? total)}${invoice?.invoiceNumber ? ` (invoice ${invoice.invoiceNumber})` : ''}`;
      return { to: [user.email], values: {
        name: user.name || 'Customer', project: getOrderDisplayName(order), price: isFree ? 'FREE' : money(total),
        offer: order.projectSnapshot?.offer?.title || '', startedOn: formatIndiaDateTime(Date.now()), paymentPlan,
        receivedSoFar: !isFree && paidNow > 0 ? money(paidNow) : '', dueNow: !isFree && paidNow <= 0 ? due : '',
      } };
    },
  },
  sendProjectCancellationEmail: {
    subject: 'Project Cancelled',
    text: lines(
      'Hello {{name}},', '',
      'Your project has been cancelled. The details are below.', '',
      '## Project Details',
      '**Project:** {{project}}', '**Cancelled On:** {{cancelledOn}}', '**Reason:** {{reason}}', '',
      '{{refundTable}}', '',
      'If you have any questions about this cancellation or the refund, please contact our support team.', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: detail('Customer name', 'Ravi Kumar'),
      project: PROJECT,
      cancelledOn: detail('Cancelled on', '17 Oct 2026, 11:30 am', 'Date and time of the cancellation'),
      reason: detail('Cancellation reason', 'Requirements changed', 'Empty when no reason was given'),
    },
    blocks: {
      refundTable: { label: 'Refund details', hint: 'Table of refunds and their total; left out when nothing was refunded', sample: () => refundTable([{ method: 'wallet', amount: 5000 }, { method: 'upi', amount: 2500, referenceId: 'UPI123456' }]) },
    },
    build(user, order, refunds = [], cancellationReason = '') {
      if (!user?.email) return null;
      return {
        to: [user.email],
        values: { name: user.name || 'Customer', project: getOrderDisplayName(order), cancelledOn: formatIndiaDateTime(Date.now()), reason: cancellationReason || '' },
        blocks: { refundTable: refundTable(refunds) },
      };
    },
  },
  sendProjectUpdateEmail: {
    subject: 'Project Update: {{project}} - Milestone Completed',
    text: lines(
      'Hello {{name}},', '',
      'We have an exciting update on your website project **{{project}}**!', '',
      '## Milestone Completed',
      '**{{milestone}}** is now complete!',
      '{{message}}', '',
      '**Project Progress:** {{progress}} complete', '',
      '{{developer}} is working diligently to move your project forward. If you have any questions or need clarification, please do not hesitate to reach out.', '',
      'You can log in to your account to view detailed updates and provide feedback.', '',
      'Thank you for your continued collaboration!', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME, project: PROJECT, milestone: detail('Milestone', 'Home page design'),
      message: detail('Update message', 'The home page is ready for your review.', 'What the developer wrote; links become “Text: URL”'),
      progress: detail('Progress', '60%'), developer: DEVELOPER,
    },
    blocks: {},
    build(user, updateData = {}) {
      if (!user?.email) return null;
      return { to: [user.email], values: {
        name: text(updateData.clientName || user.name), project: text(updateData.projectName), milestone: text(updateData.checkpointName),
        message: plainButtons(updateData.message), progress: updateData.projectProgress === undefined ? '' : `${updateData.projectProgress}%`, developer: text(updateData.developerName),
      } };
    },
  },
  sendProjectMessageEmail: {
    subject: 'New Message About Your Project: {{project}}',
    text: lines(
      'Hello {{name}},', '',
      'You have received a new message regarding your website project **{{project}}**:', '',
      '{{message}}', '',
      '**Current Progress:** {{progress}} complete', '',
      'To view all messages and updates, please log in to your account dashboard. If you have any questions or need to respond to this message, you can do so through your account or by replying to this email.', '',
      'Thank you for your continued collaboration!', '',
      'Best regards,', '{{developer}}', 'Mera Software Team',
    ),
    variables: {
      name: NAME, project: PROJECT,
      message: detail('Message', 'Please send us your logo.', 'What the developer wrote; links become “Text: URL”'),
      progress: detail('Progress', '60%'), developer: DEVELOPER,
    },
    blocks: {},
    build(user, messageData = {}) {
      if (!user?.email) return null;
      return { to: [user.email], values: {
        name: text(messageData.clientName || user.name), project: text(messageData.projectName), message: plainButtons(messageData.message),
        progress: messageData.projectProgress === undefined ? '' : `${messageData.projectProgress}%`, developer: text(messageData.developerName),
      } };
    },
  },

  // --- Invoices and renewals ----------------------------------------------------------------
  sendMonthlyInvoiceEmail: {
    subject: '✅ Plan Activated | ⚠️ Bill Pending - Invoice #{{invoiceNumber}}',
    text: lines(
      'Hello {{name}},', '',
      'Hope you are doing well!', '',
      '## Your Plan is Active',
      'Your Website Update Plan has been automatically renewed and is now **ACTIVE**. You can now submit your website update requests for this month!', '',
      '## Payment Pending',
      'However, your monthly bill is still **DUE** and needs to be cleared. You can send website update requests, but your updates will only be processed **after** the bill payment is confirmed.', '',
      '## Billing Details',
      '**Plan:** {{plan}}', '**Billing Period:** {{period}}', '**Invoice Number:** {{invoiceNumber}}', '**Invoice Date:** {{invoiceDate}}',
      '**Amount Due:** {{amount}}', '**Payment Due Date:** {{dueDate}}', '**Status:** PAYMENT PENDING', '',
      '## Plan Benefits (This Month)',
      '- 1 Website Update Request',
      '- Valid for 30 days ({{period}})',
      '- Quick turnaround time', '',
      '## Payment Options',
      '**UPI:** vacomputers.com@okhdfcbank',
      '**Visit our office:** VA Computers, Near New Bus Stand, Majitha, 143601', '',
      '## Payment Instructions',
      '- The invoice PDF is attached to this email for your records.',
      '- Please make the payment by {{dueDate}}.',
      '- After payment, please share the transaction screenshot with us for faster processing.',
      '- Your update requests will be processed only after payment confirmation.', '',
      '**Note:** If you have already made the payment, please disregard this reminder. Your payment will be confirmed shortly and reflected in your account.', '',
      'For any queries, feel free to contact us!', '',
      'Thank you for your continued business!', '',
      ...SIGN_OFF,
    ),
    variables: {
      name: NAME, plan: PLAN, period: detail('Billing period', '1 Oct 2026 - 31 Oct 2026'), invoiceNumber: INVOICE_NUMBER,
      invoiceDate: detail('Invoice date', '1 Oct 2026'), amount: detail('Amount due', '₹3,000'), dueDate: detail('Payment due date', '8 Oct 2026'),
    },
    blocks: {},
    build(user, order, invoice = {}, invoicePdfBuffer) {
      if (!user?.email) return null;
      return {
        to: [user.email],
        values: {
          name: text(user.name), plan: getOrderDisplayName(order, 'Website Update Plan'), period: `${day(invoice.renewalPeriodStart)} - ${day(invoice.renewalPeriodEnd)}`,
          invoiceNumber: text(invoice.invoiceNumber), invoiceDate: day(invoice.invoiceDate), amount: money(invoice.amount), dueDate: day(invoice.dueDate),
        },
        attachments: invoicePdfBuffer ? [{ filename: `Invoice-${invoice.invoiceNumber}.pdf`, content: invoicePdfBuffer }] : [],
      };
    },
  },
  sendAdminAutoRenewalNotification: {
    subject: '🔔 Monthly Bill Generated - User: {{customerName}}',
    text: lines(
      'Hi Admin,', '',
      'A monthly bill has been generated for a user’s plan.', '',
      '## User Information', '**Name:** {{customerName}}', '**Email:** {{customerEmail}}', '**User ID:** {{customerId}}', '',
      '## Invoice Details', '**Invoice Number:** {{invoiceNumber}}', '**Plan:** {{plan}}', '**Billing Period:** {{period}}',
      '**Renewal Month:** {{renewalMonth}} of 12', '**Amount:** {{amount}}', '**Status:** UNPAID', '**Due Date:** {{dueDate}}', '',
      '## Plan Status', '**Updates Available:** 1 update for this month', '**Yearly Days Remaining:** {{daysRemaining}} days', '**Current Month Expiry:** {{monthExpiry}}', '',
      '**Note:** The user has been notified via email with the invoice PDF attached.', '',
      '**Mark as paid:** {{invoiceLink}}', '**View order:** {{orderLink}}', '',
      ...SYSTEM_SIGN_OFF,
    ),
    variables: {
      customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL, customerId: detail('User ID', '64f0c0ffee1234567890abcd'),
      invoiceNumber: INVOICE_NUMBER, plan: PLAN, period: detail('Billing period', '1 Oct 2026 - 31 Oct 2026'),
      renewalMonth: detail('Renewal month', '3'), amount: detail('Amount', '₹3,000'), dueDate: detail('Due date', '8 Oct 2026'),
      daysRemaining: detail('Yearly days remaining', '275'), monthExpiry: detail('Current month expiry', '31 Oct 2026'),
      invoiceLink: detail('Invoice link', 'https://admin.example.com/invoices/123', 'The invoice in the admin dashboard'),
      orderLink: detail('Order link', 'https://admin.example.com/orders/123', 'The order in the admin dashboard'),
    },
    blocks: {},
    build(user, order, invoice = {}) {
      return { to: [process.env.ADMIN_EMAIL || 'vacomputers.com@gmail.com'], values: {
        customerName: text(user?.name), customerEmail: text(user?.email), customerId: text(user?._id),
        invoiceNumber: text(invoice.invoiceNumber), plan: getOrderDisplayName(order, 'Website Update Plan'), period: `${day(invoice.renewalPeriodStart)} - ${day(invoice.renewalPeriodEnd)}`,
        renewalMonth: text(invoice.renewalMonth), amount: money(invoice.amount), dueDate: day(invoice.dueDate),
        daysRemaining: text(order?.totalYearlyDaysRemaining), monthExpiry: day(order?.currentMonthExpiryDate),
        invoiceLink: adminLink(`/invoices/${invoice._id}`), orderLink: adminLink(`/orders/${order?._id}`),
      } };
    },
  },
  'invoice.project': {
    subject: 'Project payment summary - {{invoiceNumber}}',
    text: lines('Hello {{name}},', '', 'Your current project payment summary ({{invoiceNumber}}) is attached.', '', ...SIGN_OFF),
    variables: { name: NAME, invoiceNumber: INVOICE_NUMBER },
    blocks: {},
    build(invoice, pdf) {
      const user = invoice?.userId;
      if (!user?.email) return null;
      return {
        to: [user.email], values: { name: text(user.name || 'Customer'), invoiceNumber: text(invoice.invoiceNumber) },
        attachments: pdf ? [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdf }] : [],
      };
    },
  },
  'invoice.reminder': {
    subject: 'Payment reminder - Invoice #{{invoiceNumber}}',
    text: lines(
      'Hello {{name}},', '',
      '{{message}}', '',
      '**Invoice:** {{invoiceNumber}}', '**Amount Due:** {{amount}}', '**Due Date:** {{dueDate}}', '',
      'The invoice PDF is attached for your reference.', '',
      'Regards,', 'Mera Software Team',
    ),
    variables: {
      name: NAME,
      message: detail('Reminder message', 'This is a friendly reminder that your invoice payment is still pending.', 'The text the admin chose or typed when sending the reminder'),
      invoiceNumber: INVOICE_NUMBER, amount: detail('Amount due', '₹3,000'), dueDate: detail('Due date', '8 Oct 2026'),
    },
    blocks: {},
    build(invoice, reminderMessage, pdf) {
      const user = invoice?.userId;
      if (!user?.email) return null;
      return {
        to: [user.email], reminderInvoice: invoice._id,
        values: { name: text(user.name || 'Customer'), message: text(reminderMessage), invoiceNumber: text(invoice.invoiceNumber), amount: money(invoice.amount), dueDate: day(invoice.dueDate) },
        attachments: pdf ? [{ filename: `Invoice-${invoice.invoiceNumber}.pdf`, content: pdf }] : [],
      };
    },
  },

  // --- Account ------------------------------------------------------------------------------
  // otpUtils.sendOTPEmail does not send mail today; this template is ready for when it does.
  'auth.otp': {
    subject: 'Your Mera Software login code',
    text: lines('Hello {{name}},', '', 'Your one-time login code is **{{otp}}**. It is valid for 5 minutes.', '', 'If you did not try to log in, you can ignore this email.', '', ...SIGN_OFF),
    variables: { name: NAME, otp: detail('Login code', '482913', 'The one-time code; never share it with anyone else') },
    blocks: {},
    build(email, otp, name) {
      return email ? { to: [email], values: { name: text(name), otp: text(otp) } } : null;
    },
  },

  // --- Website ------------------------------------------------------------------------------
  sendContactFormConfirmation: {
    subject: 'Thank You for Contacting Us',
    text: lines(
      'Hello {{name}},', '',
      'Thank you for reaching out to us. We have received your request for account creation.', '',
      'Our team will review your information and contact you shortly to help set up your account.', '',
      'If you have any urgent questions, please feel free to call us directly.', '',
      ...SIGN_OFF,
    ),
    variables: { name: NAME },
    blocks: {},
    build(contactData) {
      return contactData?.email ? { to: [contactData.email], values: { name: text(contactData.name) } } : null;
    },
  },
  sendContactRequestNotification: {
    subject: 'New Account Creation Request',
    text: lines(
      'A new account creation request has been submitted through the contact form.', '',
      '## Contact Details', '**Name:** {{customerName}}', '**Email:** {{customerEmail}}', '**Phone:** {{phone}}', '**Request Type:** Account Creation',
      '**Related Product:** {{product}}', '**Message:** {{message}}', '**Date Submitted:** {{submittedOn}}', '',
      'Please reach out to this customer to complete their account setup process. You can also manage this request from the admin dashboard.',
    ),
    variables: {
      customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL, phone: detail('Phone', '+91 98765 43210'),
      product: detail('Related product', 'None'), message: detail('Message', 'I need a website for my shop.'),
      submittedOn: detail('Date submitted', '17 Oct 2026, 11:30 am IST'),
    },
    blocks: {},
    build(contactData = {}, adminEmails) {
      const to = list(adminEmails);
      if (!to.length) return null;
      return { to, values: {
        customerName: text(contactData.name), customerEmail: text(contactData.email), phone: text(contactData.phone),
        product: text(contactData.productId || 'None'), message: text(contactData.message), submittedOn: moment(Date.now()),
      } };
    },
  },
  sendCallbackConfirmation: {
    subject: 'Thank You for Your Callback Request',
    text: lines(
      'Hello {{name}},', '',
      'Thank you for requesting a callback from Mera Software.', '',
      'We have received your request and our team will contact you within 24 hours to discuss your requirements.', '',
      ...SIGN_OFF,
    ),
    variables: { name: NAME },
    blocks: {},
    build(callbackData) {
      return callbackData?.email ? { to: [callbackData.email], values: { name: text(callbackData.name) } } : null;
    },
  },
  sendCallbackRequestNotification: {
    subject: 'New Callback Request',
    text: lines(
      'A new callback request has been submitted.', '',
      '## Customer Details', '**Name:** {{customerName}}', '**Email:** {{customerEmail}}', '**Phone:** {{phone}}',
      '**Interested In:** {{interest}}', '**Date Submitted:** {{submittedOn}}', '',
      '**Action required:** please contact this customer within 24 hours.', '',
      'You can reach out to them via email or phone to discuss their requirements.',
    ),
    variables: {
      customerName: CUSTOMER_NAME, customerEmail: CUSTOMER_EMAIL, phone: detail('Phone', '+91 98765 43210'),
      interest: detail('Interested in', 'Business Website', '“General Inquiry” when the customer left it empty'),
      submittedOn: detail('Date submitted', '17 Oct 2026, 11:30 am IST'),
    },
    blocks: {},
    build(callbackData = {}, adminEmails) {
      const to = list(adminEmails);
      if (!to.length) return null;
      return { to, values: {
        customerName: text(callbackData.name), customerEmail: text(callbackData.email), phone: text(callbackData.phone),
        interest: text(callbackData.message || 'General Inquiry'), submittedOn: moment(Date.now()),
      } };
    },
  },
  // Prepared by the website through POST /website-drafts (routes/emailControl.js), which fills
  // the values; the link also stays a required link, so it can never be edited out.
  'website.subscription.confirm': {
    subject: 'Confirm your Mera Software updates',
    text: lines(
      'Please confirm that you want updates from Mera Software.', '',
      '**Topics:** {{topics}}', '',
      '**Yes, send me updates:** {{link}}', '',
      'If you did not ask for this, ignore this email — nothing will be sent to you.',
    ),
    variables: {
      topics: detail('Topics', 'SEO and offers', 'The topics the reader chose'),
      link: detail('Confirmation link', 'https://www.merasoftware.com/subscribe/confirm?token=sample', 'Always added to the mail, even if removed here'),
    },
    blocks: {},
  },
  'website.subscription.manage': {
    subject: 'Your Mera Software updates',
    text: lines(
      'This address is already subscribed to Mera Software updates. You can change your topics or unsubscribe from the link below.', '',
      '**Manage my updates:** {{link}}', '',
      'If you did not ask for this, ignore this email — nothing has changed.',
    ),
    variables: {
      topics: detail('Topics', 'SEO and offers', 'The topics the reader chose'),
      link: detail('Manage link', 'https://www.merasoftware.com/subscribe/manage?token=sample', 'Always added to the mail, even if removed here'),
    },
    blocks: {},
  },
};

definitions['offer.payment.reminder'] = {
  ...definitions['invoice.reminder'],
  build(invoice, reminderMessage) {
    const mail = definitions['invoice.reminder'].build(invoice, reminderMessage);
    return mail ? { ...mail, reminderInvoice: undefined } : null;
  },
};
definitions['offer.reserved'] = {
  subject: 'Your offer is reserved',
  text: lines('Hello {{name}},', '', 'You have reserved {{offerTitle}}.',
    '**Reserved price:** {{price}}', '**Reserved on:** {{reservedAt}}',
    '**Payment deadline:** {{expiresAt}}', '',
    'Your reservation is valid for 72 hours from the reserved time above. Complete the required first payment before the deadline to lock the agreed price.',
    'Our team will help you with your project and payment steps. Reserving does not itself confirm a payment or start a project.', '',
    '**My offers:** {{link}}', '', ...SIGN_OFF),
  variables: { name: detail('Name', 'Client'), offerTitle: detail('Offer', 'Website offer'),
    price: detail('Reserved price', '₹5,000'), reservedAt: detail('Reserved on', '24 Oct 2026, 10:00 am IST'),
    expiresAt: detail('Payment deadline', '27 Oct 2026, 10:00 am IST'), link: detail('My offers', 'https://www.merasoftware.com/account/offers') },
  blocks: {},
  build(reservation, user) {
    if (!user?.email || !process.env.PORTFOLIO_WEBSITE_URL) return null;
    const href = link(process.env.PORTFOLIO_WEBSITE_URL, '/account/offers');
    return { to: [user.email], requiredLinks: [href], values: {
      name: text(user.name), offerTitle: text(reservation.offerSnapshot.title), price: money(reservation.reservedPrice),
      reservedAt: moment(reservation.reservedAt), expiresAt: moment(reservation.expiresAt), link: href,
    } };
  },
};
// Owner decision 21: the exact new deadline, never a relative "hours left" that ages in transit.
definitions['offer.reservation.extended'] = {
  subject: 'Your offer reservation has been extended',
  text: lines('Hello {{name}},', '', 'Our team has extended your reservation for {{offerTitle}}.',
    '**Reserved price:** {{price}}', '**New payment deadline:** {{deadline}}', '',
    'Complete the required first payment before this deadline to keep the reserved price.', '',
    '**My offers:** {{link}}', '', ...SIGN_OFF),
  variables: { name: detail('Name', 'Client'), offerTitle: detail('Offer', 'Website offer'),
    price: detail('Reserved price', '₹5,000'), deadline: detail('New payment deadline', '30 Oct 2026, 10:00 am IST'),
    link: detail('My offers', 'https://www.merasoftware.com/account/offers') },
  blocks: {},
  build(reservation, user) {
    if (!user?.email || !process.env.PORTFOLIO_WEBSITE_URL || !reservation.extendedUntil) return null;
    const href = link(process.env.PORTFOLIO_WEBSITE_URL, '/account/offers');
    return { to: [user.email], requiredLinks: [href], values: {
      name: text(user.name), offerTitle: text(reservation.offerSnapshot.title), price: money(reservation.reservedPrice),
      deadline: moment(reservation.extendedUntil), link: href,
    } };
  },
};
module.exports = { definitions, refundTable };
