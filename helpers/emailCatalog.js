// Stable event keys shared by builders, policies, templates and the review UI.
// [key, section, label, group?]: `section` also decides the application (below), so it never changes
// for display. `group` only gathers the mails one job sends (customer + admin copy) into one box on the
// website's Communication page; without it the action is its own group.
const events = [
  ['lead.created', 'Leads', 'New lead welcome'],
  ['sendClientAccountCreatedEmail', 'Leads', 'Client account created'],
  ['lead.proposal', 'Leads', 'Proposal sent'],
  ['lead.finalMessage', 'Leads', 'Final message'],
  ['plan.request.admin', 'Leads', 'Plan request (admin)', 'Plan request'],
  ['plan.request.received', 'Leads', 'Plan request received', 'Plan request'],
  ['sendUpdateRequestNotification', 'Updates', 'New update request (admin)', 'Update request'],
  ['sendUserConfirmation', 'Updates', 'Update request received', 'Update request'],
  ['sendDeveloperAssignedNotification', 'Updates', 'Developer assigned (customer)', 'Developer assigned'],
  ['sendUpdateCompletedNotification', 'Updates', 'Update completed'],
  ['sendDeveloperAssignmentEmail', 'Updates', 'Assignment (developer)', 'Developer assigned'],
  ['sendPurchaseConfirmationEmail', 'Orders', 'Purchase confirmation', 'Purchase'],
  ['sendMonthlyLimitedPlanActivationEmail', 'Plans', 'Plan activation'],
  ['sendAdminPurchaseConfirmationEmail', 'Orders', 'Purchase confirmation (admin)', 'Purchase'],
  ['sendAdminUPIPendingNotification', 'Payments', 'UPI payment pending (admin)', 'Payment'],
  ['sendWalletRechargeConfirmationEmail', 'Wallet', 'Wallet recharge confirmed', 'Wallet recharge'],
  ['sendPaymentRejectionEmail', 'Payments', 'Payment rejected', 'Payment'],
  ['sendProjectCreatedEmail', 'Projects', 'Project created'],
  ['sendProjectCancellationEmail', 'Projects', 'Project cancelled'],
  ['sendWalletRechargeRejectionEmail', 'Wallet', 'Wallet recharge rejected', 'Wallet recharge'],
  ['sendContactFormConfirmation', 'Website', 'Contact form received', 'Contact form'],
  ['sendContactRequestNotification', 'Website', 'Contact request (admin)', 'Contact form'],
  ['sendCallbackConfirmation', 'Website', 'Callback request received', 'Callback request'],
  ['sendCallbackRequestNotification', 'Website', 'Callback request (admin)', 'Callback request'],
  ['sendProjectUpdateEmail', 'Projects', 'Project progress update'],
  ['sendProjectMessageEmail', 'Projects', 'Project message'],
  ['sendMonthlyInvoiceEmail', 'Invoices', 'Monthly invoice'],
  ['sendAdminAutoRenewalNotification', 'Renewals', 'Auto renewal (admin)'],
  ['sendPlanClosureEmailToCustomer', 'Plans', 'Plan closure (customer)', 'Plan closure'],
  ['sendPlanClosureEmailToAdmin', 'Plans', 'Plan closure (admin)', 'Plan closure'],
  ['invoice.project', 'Invoices', 'Project payment summary'],
  ['invoice.reminder', 'Invoices', 'Payment reminder'],
  ['offer.payment.reminder', 'Invoices', 'Offer payment reminder (scheduled)'],
  ['offer.reserved', 'Offers', 'Offer reservation confirmation', 'Offer reservation'],
  ['offer.reservation.extended', 'Offers', 'Offer reservation extended', 'Offer reservation'],
  ['auth.otp', 'Account', 'Login OTP'],
  ['website.subscription.confirm', 'Website', 'Subscription confirmation', 'Subscription'],
  ['website.subscription.manage', 'Website', 'Subscription management', 'Subscription'],
  ['plan.started', 'Plans', 'Plan started', 'Plan steps'],
  ['plan.payment.received', 'Plans', 'Plan payment received', 'Plan steps'],
  ['plan.upload.in_progress', 'Plans', 'Plan upload in progress', 'Plan upload status'],
  ['plan.upload.completed', 'Plans', 'Plan upload done', 'Plan upload status'],
  ['plan.upload.rejected', 'Plans', 'Plan upload rejected', 'Plan upload status'],
  ['plan.work_update', 'Plans', 'Plan work update', 'Plan steps'],
  ['plan.payment.submitted', 'Plans', 'Plan payment submitted', 'Plan payment'],
  ['plan.payment.rejected', 'Plans', 'Plan payment rejected', 'Plan payment'],
  ['plan.purchase.admin', 'Plans', 'Plan purchase (admin)', 'Plan payment'],
];
// Mail a customer's own portal action starts. It never asks anyone: the action is On (mail
// sends at once) or Off (no mail). Every other action's user reviews its mail first.
// A website plan request (controller/lead/planRequest.js) is started by the visitor too, so it is Off
// until an admin turns it On (merasoftware/src/docs/plan.md §8.3: new actions start Off).
// Plan payment mails (plan.md 4.1) are Off until turned On for the same reason; a rejection is
// prepared in the admin's reject request but follows the same On/Off rule.
const CUSTOMER_TRIGGERED = new Set(['sendUpdateRequestNotification', 'sendUserConfirmation', 'sendAdminUPIPendingNotification',
  'plan.request.admin', 'plan.request.received', 'plan.payment.submitted', 'plan.payment.rejected', 'plan.purchase.admin']);
// Sent by the server itself (scheduler or a committed reservation operation), never a draft.
// Plan steps are system mail too: they go out the moment the step happens (the client is told at
// every step), whichever request or job caused it (helpers/servicePlanNotifications.js).
const SYSTEM_TRIGGERED = new Set(['offer.payment.reminder', 'offer.reserved', 'offer.reservation.extended',
  'plan.started', 'plan.payment.received', 'plan.upload.in_progress', 'plan.upload.completed', 'plan.upload.rejected', 'plan.work_update']);
const catalog = events.map(([key, section, label, group = label]) => ({
  key, section, label, group, application: section === 'Website' ? 'website' : 'portal',
  trigger: SYSTEM_TRIGGERED.has(key) ? 'system' : CUSTOMER_TRIGGERED.has(key) ? 'customer' : 'admin',
}));
const byKey = new Map(catalog.map(event => [event.key, event]));
const eventKeys = application => catalog.filter(event => event.application === application).map(event => event.key);
const isCustomerTriggered = key => byKey.get(key)?.trigger === 'customer';
const isAutomaticEvent = key => isCustomerTriggered(key) || byKey.get(key)?.trigger === 'system';
const customerEventKeys = catalog.filter(event => event.trigger === 'customer').map(event => event.key);
module.exports = { events: catalog, byKey, eventKeys, isCustomerTriggered, isAutomaticEvent, customerEventKeys };
