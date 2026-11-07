// Stable event keys shared by builders, policies, templates and the review UI.
// [key, section, label, group?]: `section` also decides the application (below), so it never changes
// for display. `group` only gathers the mails one job sends (customer + admin copy) into one box on the
// website's Communication page; without it the action is its own group.
const events = [
  ['lead.created', 'Leads', 'New lead welcome'],
  ['sendClientAccountCreatedEmail', 'Leads', 'Client account created'],
  ['lead.proposal', 'Leads', 'Proposal sent'],
  ['lead.finalMessage', 'Leads', 'Final message'],
  ['lead.finalMessageExpired', 'Leads', 'Final message expired'],
  ['lead.message', 'Leads', 'General message'],
  ['plan.request.admin', 'Leads', 'Plan request (admin)', 'Plan request'],
  ['plan.request.received', 'Leads', 'Plan request received', 'Plan request'],
  ['sendUpdateRequestNotification', 'Updates', 'New update request (admin)', 'Update request'],
  ['sendUserConfirmation', 'Updates', 'Update request received', 'Update request'],
  ['sendUploadDeliveryStuck', 'Updates', 'Upload stuck, retry needed (admin)'],
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
  // Send Upgrade on a completed project's page (helpers/complimentaryUpgrade.js).
  ['project.upgrade.offer', 'Projects', 'Complimentary upgrade offer', 'Complimentary upgrade'],
  ['project.upgrade.started', 'Projects', 'Complimentary upgrade started', 'Complimentary upgrade'],
  ['project.upgrade.completed', 'Projects', 'Complimentary upgrade completed', 'Complimentary upgrade'],
  ['sendMonthlyInvoiceEmail', 'Invoices', 'Monthly invoice'],
  ['sendAdminAutoRenewalNotification', 'Renewals', 'Auto renewal (admin)'],
  ['sendPlanClosureEmailToCustomer', 'Plans', 'Plan closure (customer)', 'Plan closure'],
  ['sendPlanClosureEmailToAdmin', 'Plans', 'Plan closure (admin)', 'Plan closure'],
  ['invoice.project', 'Invoices', 'Project payment summary'],
  ['invoice.reminder', 'Invoices', 'Payment reminder'],
  ['offer.payment.reminder', 'Invoices', 'Offer payment reminder (scheduled)'],
  ['offer.reserved', 'Offers', 'Offer reservation confirmation', 'Offer reservation'],
  ['offer.reservation.extended', 'Offers', 'Offer reservation extended', 'Offer reservation'],
  ['offer.reservation.expired', 'Offers', 'Offer reservation expired', 'Offer reservation'],
  ['offer.reservation.reminder', 'Offers', 'Offer reservation reminder (24 hours left)', 'Offer reservation'],
  ['offer.reservation.lastHour', 'Offers', 'Offer reservation reminder (1 hour left)', 'Offer reservation'],
  ['offer.start.request.admin', 'Offers', 'Start project request (admin)', 'Offer reservation'],
  ['offer.start.request.received', 'Offers', 'Start project request received', 'Offer reservation'],
  ['package.start.request.admin', 'Offers', 'Package start request (admin)', 'Package start request'],
  ['package.start.request.received', 'Offers', 'Package start request received', 'Package start request'],
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
const SYSTEM_TRIGGERED = new Set(['lead.finalMessageExpired', 'sendUploadDeliveryStuck', 'offer.payment.reminder','offer.reserved', 'offer.reservation.extended',
  'offer.reservation.expired', 'offer.reservation.reminder', 'offer.reservation.lastHour', 'offer.start.request.admin', 'offer.start.request.received',
  // Package Start requests (helpers/packageStart.js) are sent by its job, like the offer Start messages; the
  // whole feature stays behind PACKAGE_START_REQUESTS_ENABLED until it is tested on a real phone.
  'package.start.request.admin', 'package.start.request.received',
  'plan.started', 'plan.payment.received', 'plan.upload.in_progress', 'plan.upload.completed', 'plan.upload.rejected', 'plan.work_update']);
// Mail addressed to admins or a developer. Every other action reaches a customer or a lead.
const TEAM = new Set(['plan.request.admin', 'sendUpdateRequestNotification', 'sendUploadDeliveryStuck', 'sendDeveloperAssignmentEmail',
  'sendAdminPurchaseConfirmationEmail', 'sendAdminUPIPendingNotification', 'sendContactRequestNotification', 'sendCallbackRequestNotification',
  'sendAdminAutoRenewalNotification', 'sendPlanClosureEmailToAdmin', 'plan.purchase.admin', 'offer.start.request.admin', 'package.start.request.admin']);
// Team mail addressed to the admins (not the developer): its recipients and WhatsApp numbers come from the
// admins' own settings (helpers/teamContacts.js), whatever address its builder names.
const ADMIN_RECIPIENT = new Set([...TEAM].filter(key => key !== 'sendDeveloperAssignmentEmail'));
const isAdminRecipientEvent = key => ADMIN_RECIPIENT.has(key);
// Subscription confirmation needs the email link; reviewDelivery.js refuses WhatsApp for it.
const EMAIL_ONLY = new Set(['website.subscription.confirm', 'website.subscription.manage']);
const CHANNELS = ['whatsapp', 'email', 'both'];
// Each action's "Send via" until an admin changes it (merasoftware/src/docs/reservation-countdown.md,
// owner decision 5 Nov 2026): customer mail goes by WhatsApp only while the system is tested, because a
// wrong WhatsApp can be deleted for everyone and an email can't. Team mail keeps Email + WhatsApp.
// Owner decision 7 Nov 2026: what a reserving customer is told about the countdown and their start request
// goes by Email + WhatsApp (every reserving account has both).
const CUSTOMER_BOTH = new Set(['offer.reservation.reminder', 'offer.reservation.lastHour', 'offer.start.request.received', 'offer.reservation.expired', 'package.start.request.received']);
const defaultChannel = key => EMAIL_ONLY.has(key) ? 'email' : TEAM.has(key) || CUSTOMER_BOTH.has(key) ? 'both' : 'whatsapp';
const catalog = events.map(([key, section, label, group = label]) => ({
  key, section, label, group, application: section === 'Website' ? 'website' : 'portal',
  trigger: SYSTEM_TRIGGERED.has(key) ? 'system' : CUSTOMER_TRIGGERED.has(key) ? 'customer' : 'admin',
  audience: TEAM.has(key) ? 'team' : 'customer', defaultChannel: defaultChannel(key), channels: EMAIL_ONLY.has(key) ? ['email'] : CHANNELS,
}));
const byKey = new Map(catalog.map(event => [event.key, event]));
const eventKeys = application => catalog.filter(event => event.application === application).map(event => event.key);
const isCustomerTriggered = key => byKey.get(key)?.trigger === 'customer';
const isAutomaticEvent = key => isCustomerTriggered(key) || byKey.get(key)?.trigger === 'system';
const customerEventKeys = catalog.filter(event => event.trigger === 'customer').map(event => event.key);
// The action's route: its saved policy, else its default. The one rule every send follows.
const channelFor = (key, policy) => EMAIL_ONLY.has(key) ? 'email' : CHANNELS.includes(policy?.channel) ? policy.channel : defaultChannel(key);
module.exports = { events: catalog, byKey, eventKeys, isCustomerTriggered, isAutomaticEvent, isAdminRecipientEvent, customerEventKeys, channelFor, CHANNELS };
