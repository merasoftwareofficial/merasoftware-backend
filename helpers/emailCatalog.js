// Stable event keys shared by builders, policies, templates and the review UI.
const events = [
  ['lead.created', 'Leads', 'New lead welcome'],
  ['sendClientAccountCreatedEmail', 'Leads', 'Client account created'],
  ['sendUpdateRequestNotification', 'Updates', 'New update request (admin)'],
  ['sendUserConfirmation', 'Updates', 'Update request received'],
  ['sendDeveloperAssignedNotification', 'Updates', 'Developer assigned (customer)'],
  ['sendUpdateCompletedNotification', 'Updates', 'Update completed'],
  ['sendDeveloperAssignmentEmail', 'Updates', 'Assignment (developer)'],
  ['sendPurchaseConfirmationEmail', 'Orders', 'Purchase confirmation'],
  ['sendMonthlyLimitedPlanActivationEmail', 'Plans', 'Plan activation'],
  ['sendAdminPurchaseConfirmationEmail', 'Orders', 'Purchase confirmation (admin)'],
  ['sendAdminUPIPendingNotification', 'Payments', 'UPI payment pending (admin)'],
  ['sendWalletRechargeConfirmationEmail', 'Wallet', 'Wallet recharge confirmed'],
  ['sendPaymentRejectionEmail', 'Payments', 'Payment rejected'],
  ['sendProjectCreatedEmail', 'Projects', 'Project created'],
  ['sendProjectCancellationEmail', 'Projects', 'Project cancelled'],
  ['sendWalletRechargeRejectionEmail', 'Wallet', 'Wallet recharge rejected'],
  ['sendContactFormConfirmation', 'Website', 'Contact form received'],
  ['sendContactRequestNotification', 'Website', 'Contact request (admin)'],
  ['sendCallbackConfirmation', 'Website', 'Callback request received'],
  ['sendCallbackRequestNotification', 'Website', 'Callback request (admin)'],
  ['sendProjectUpdateEmail', 'Projects', 'Project progress update'],
  ['sendProjectMessageEmail', 'Projects', 'Project message'],
  ['sendMonthlyInvoiceEmail', 'Invoices', 'Monthly invoice'],
  ['sendAdminAutoRenewalNotification', 'Renewals', 'Auto renewal (admin)'],
  ['sendPlanClosureEmailToCustomer', 'Plans', 'Plan closure (customer)'],
  ['sendPlanClosureEmailToAdmin', 'Plans', 'Plan closure (admin)'],
  ['invoice.project', 'Invoices', 'Project payment summary'],
  ['invoice.reminder', 'Invoices', 'Payment reminder'],
  ['offer.payment.reminder', 'Invoices', 'Offer payment reminder (scheduled)'],
  ['auth.otp', 'Account', 'Login OTP'],
  ['website.subscription.confirm', 'Website', 'Subscription confirmation'],
  ['website.subscription.manage', 'Website', 'Subscription management'],
];
// Mail a customer's own portal action starts. It never asks anyone: the action is On (mail
// sends at once) or Off (no mail). Every other action's user reviews its mail first.
const CUSTOMER_TRIGGERED = new Set(['sendUpdateRequestNotification', 'sendUserConfirmation', 'sendAdminUPIPendingNotification']);
const catalog = events.map(([key, section, label]) => ({
  key, section, label, application: section === 'Website' ? 'website' : 'portal',
  trigger: key === 'offer.payment.reminder' ? 'system' : CUSTOMER_TRIGGERED.has(key) ? 'customer' : 'admin',
}));
const byKey = new Map(catalog.map(event => [event.key, event]));
const eventKeys = application => catalog.filter(event => event.application === application).map(event => event.key);
const isCustomerTriggered = key => byKey.get(key)?.trigger === 'customer';
const isAutomaticEvent = key => isCustomerTriggered(key) || byKey.get(key)?.trigger === 'system';
const customerEventKeys = catalog.filter(event => event.trigger === 'customer').map(event => event.key);
module.exports = { events: catalog, byKey, eventKeys, isCustomerTriggered, isAutomaticEvent, customerEventKeys };
