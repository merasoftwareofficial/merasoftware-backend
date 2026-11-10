const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const { readPackages, quotePackage, quoteChoice, fail } = require('./salesPackages');
const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { requireCategoryForNewProject } = require('./projectCategories');
const { resolveProjectPricing } = require('./projectPricing');
const { buildInstallments, buildCycleInstallments } = require('./projectInstallments');
const { persistAdminProject } = require('./adminProjectCreation');
const { receiveFirstPaymentInSession } = require('./projectPaymentSettlement');
const { prepareUpiPaymentEvidence } = require('./upiPaymentEvidence');
const { promoteMemberToClient } = require('./clientAccount');
const { syncProjectFinalInvoice } = require('./projectFinalInvoice');
const { parsePhone } = require('./phoneNumber');

// A customer buys a package project on the website and pays its first payment in the same request (owner
// decisions 9 Nov 2026). The project is the one the admin form makes (adminCreateProjectOrder.js): the same
// pricing (resolveProjectPricing), the same transaction (persistAdminProject) and the same settlement
// (projectPaymentSettlement.js), so everything after this call runs as it does for any project. The project
// exists only together with its payment: the wallet part settles at once, a UPI remainder waits for the admin.
// The price is never taken from the customer: it is worked out here and must match what they saw.
// Behind PACKAGE_START_REQUESTS_ENABLED, the one switch of the package start system.
const enabled = () => process.env.PACKAGE_START_REQUESTS_ENABLED === 'true';
const cents = value => Math.round(Number(value) * 100);
const safeId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
const DEFAULT_STARTING_NODE_TITLE = 'Project Started';

// The UPI payee the website shows for the remainder; the portal's pages hold the same account.
const payee = () => ({ upiId: process.env.UPI_PAYEE_ID || 'vacomputers.com@okhdfcbank', payeeName: process.env.UPI_PAYEE_NAME || 'VA Computer' });

async function activeAccount(userId, select = 'isGuest isActive deletedAt') {
  const user = await User.findById(userId).select(select).lean();
  if (!user || user.isGuest || user.isActive === false || user.deletedAt) fail('An active permanent account is required', 403);
  return user;
}

async function paymentInfo(userId) {
  const user = await activeAccount(userId, 'walletBalance isGuest isActive deletedAt');
  return { walletBalance: Number(user.walletBalance || 0), ...payee(), enabled: enabled() };
}

// What the customer asked for, as the quote prices it. One place for the one-time and the monthly package.
async function quoteForPurchase(item, choice) {
  const offers = (await fetchWebsiteCatalogue()).offers;
  const quoted = quotePackage(item, offers);
  const priced = quoteChoice(item, quoted, choice || {});
  return { quoted, priced };
}

const publishedPackage = async packageId => {
  if (!safeId(packageId)) fail('Choose a package');
  const item = (await readPackages()).find(row => row.id === packageId && row.status === 'published');
  if (!item) fail('This package is not available.', 404);
  return item;
};

// The portal's "Start a Project" list (owner decision 10 Nov 2026): the published one-time packages a signed-in
// customer can buy, each with the price the purchase would charge. It reads the same quote as the purchase, so
// the list, the choice quote and the payment can never disagree. Nothing internal (service references, frozen
// add-on pricing, page design) is sent. While the package start system is off the list is empty, and the portal
// shows only its call-back form.
async function catalogueForCustomer(userId) {
  await activeAccount(userId);
  if (!enabled()) return { enabled: false, packages: [] };
  const offers = (await fetchWebsiteCatalogue()).offers;
  const packages = (await readPackages())
    .filter(item => item.status === 'published' && item.billing === 'one_time')
    .map(item => {
      const { quote } = quotePackage(item, offers);
      return { id: item.id, name: item.name, description: item.description, category: item.category, billing: item.billing,
        portalUploads: item.portalUploads, paymentOptions: item.paymentOptions, inclusions: item.inclusions, terms: quote.terms,
        mainPrice: item.regularPrice, price: quote.finalPrice, discountAmount: quote.discountAmount,
        offer: quote.offer ? { title: quote.offer.title, endsAt: quote.offer.endsAt } : null };
    });
  return { enabled: true, packages };
}

// The price of one choice on one package: the quote the purchase checks (quoteKey and dueNow come from here).
async function quoteForCustomer(userId, packageId, choice) {
  await activeAccount(userId);
  if (!enabled()) fail('Starting a project from a package is not enabled yet', 503);
  const item = await publishedPackage(packageId);
  return (await quoteForPurchase(item, choice)).priced;
}

async function purchasePackage({ userId, packageId, choice, quoteKey, dueNow, creationKey, countryCode, phone, upiTransactionId }) {
  if (!enabled()) fail('Starting a project from a package is not enabled yet', 503);
  if (!safeId(packageId)) fail('Choose a package');
  if (typeof creationKey !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(creationKey)) fail('Invalid purchase request key');
  if (!choice || typeof choice !== 'object') fail('Choose how you want to buy this package');
  const enteredPhone = phone ? parsePhone({ countryCode, phone }) : null;

  const user = await User.findById(userId);
  if (!user || user.isGuest || user.isActive === false || user.deletedAt) fail('An active permanent account is required', 403);
  const roles = user.roles || [];
  const isMember = roles.length > 0 && roles.every(role => role === 'member');
  if (!isMember && !roles.includes('customer')) fail('Use a client account to start a project', 403);
  // Owner rule: no lead without a phone. Older accounts add it here once (HTTP 428 asks for it).
  if (!user.phone && !enteredPhone) fail('Add your mobile number to start your project', 428);

  const item = (await readPackages()).find(row => row.id === packageId && row.status === 'published');
  if (!item) fail('This package is not available.', 404);
  if (!item.billing) fail('This package cannot be bought online yet', 404);
  const { quoted, priced } = await quoteForPurchase(item, choice);
  // What the customer saw must be what they pay: a changed price or offer sends them back to review it.
  if (typeof quoteKey !== 'string' || quoteKey !== quoted.quoteKey || (dueNow !== undefined && cents(dueNow) !== cents(priced.dueNow))) {
    fail('Package, offer or terms changed. Review the new price.', 409);
  }
  if (!(cents(priced.dueNow) > 0)) fail('This package has nothing to pay online. Ask our team to start it.', 400);
  const categoryEntry = await requireCategoryForNewProject(item.category);
  const monthly = item.billing === 'monthly';
  const sellingPrice = monthly ? priced.finalPrice : quoted.quote.finalPrice;
  const commercial = await resolveProjectPricing({ body: { packageId, packageQuoteKey: quoted.quoteKey, sellingPrice, ...(monthly ? { monthlyChoice: choice } : {}) },
    category: item.category, basePrice: categoryEntry.basePrice || 0, features: [], referenceTotal: 0, userId });
  const finalPrice = commercial.finalPrice;
  const monthlyTerm = commercial.monthly || null;
  const installmentCount = !monthly && priced.installments?.length ? priced.installments.length : 0;
  const isPartialPayment = Boolean(monthlyTerm) || installmentCount > 0;
  const startingNodeTitle = categoryEntry.startingNodeTitle || DEFAULT_STARTING_NODE_TITLE;
  const creationHash = createHash('sha256').update(JSON.stringify({ userId: String(userId), packageId, choice, quoteKey })).digest('hex');

  // A UPI remainder needs the customer's reference; its evidence (12+ digits, never used before) is checked
  // before anything is written. The wallet is read again inside the transaction, where the split is final.
  const balanceBefore = Number(user.walletBalance || 0);
  const upiReference = String(upiTransactionId || '').trim();
  const needsUpi = cents(balanceBefore) < cents(priced.dueNow);
  if (needsUpi && !upiReference) fail('UPI transaction ID is required for the amount not covered by the wallet');
  const transactionId = `PKG${new mongoose.Types.ObjectId()}`;
  const preparedEvidence = needsUpi ? await prepareUpiPaymentEvidence({ reference: upiReference, transactionId, capturedVia: 'customer' }) : null;

  const orderData = {
    paymentPolicy: commercial.paymentPolicy || null,
    projectCreationKey: `${userId}:${creationKey}`, projectCreationHash: creationHash,
    userId, price: finalPrice, totalAmount: finalPrice,
    // A customer's purchase is approved only by money: the wallet part at once, a UPI part by the admin.
    orderVisibility: 'pending-approval', status: 'pending',
    isWebsiteProject: true, isPartialPayment, paidAmount: 0, remainingAmount: finalPrice, paymentComplete: false,
    projectSnapshot: {
      displayName: commercial.agreement.package?.name || categoryEntry.label, categoryLabel: categoryEntry.label, category: item.category,
      startingNodeTitle, basePrice: commercial.basePrice, referenceTotal: commercial.referenceTotal, finalPrice, features: [],
      salesAgreement: commercial.agreement,
      ...(commercial.agreement.offer ? { offer: { slug: commercial.agreement.offer.slug, title: commercial.agreement.offer.title } } : {}),
    },
    orderItems: [{ id: `project:${item.category}`, name: commercial.agreement.package?.name || `${categoryEntry.label} (Base)`, type: 'main', quantity: 1,
      originalPrice: commercial.basePrice, finalPrice: commercial.basePrice }],
  };
  if (monthlyTerm) orderData.installments = buildCycleInstallments(monthlyTerm.cyclePrice, monthlyTerm.totalCycles, monthlyTerm.cycleMonths, monthlyTerm.startsAt);
  else if (installmentCount) orderData.installments = buildInstallments(finalPrice, installmentCount);

  let promoted = false;
  const { order, invoice, reused, purchase } = await persistAdminProject({
    orderData, startingNodeTitle, actorId: userId, clientPurchase: true,
    sourceOffer: commercial.sourceOffer, sourceReservationId: commercial.sourceReservationId,
    async purchasePayment({ order: created, invoice: first, client, session }) {
      if (!client.phone) { client.phone = enteredPhone; client.phoneVerified = false; }
      // Paying for a project makes a member a client, in this same transaction (clientAccount.js).
      if (!(client.roles || []).includes('customer')) { await promoteMemberToClient(client, { session }); promoted = true; }
      else if (client.isModified('phone')) await client.save({ session });
      const wallet = await User.findById(userId).select('walletBalance').session(session);
      const due = cents(first.amount);
      const walletPart = Math.min(cents(wallet?.walletBalance || 0), due);
      const upiPart = due - walletPart;
      if (upiPart > 0 && !preparedEvidence) fail('Your wallet balance changed. Try again.', 409);
      const result = await receiveFirstPaymentInSession({ order: created, walletAmount: walletPart / 100, upiAmount: upiPart / 100, upiReference, transactionId, preparedEvidence, session });
      if (!result.walletPaid) { await created.save({ session }); await syncProjectFinalInvoice(created, { session }); }
      return { walletPaid: result.walletPaid, upiPending: result.upiPending, dueNow: due / 100 };
    },
  });
  if (reused) return { orderId: String(order._id), approved: order.orderVisibility === 'approved', reused: true, promoted: false };

  // After the commit: the new client's Won lead, the customer's project mail and the team's notice. A failure
  // here never undoes a payment that is already recorded.
  const fresh = await User.findById(userId);
  const after = async (label, work) => { try { await work(); } catch (error) { console.error(`[package purchase] ${label}:`, error.message); } };
  if (promoted) await after('Won lead', () => require('./wonLead').ensureWonLead(fresh));
  // The customer's mail is the package purchase one (it says what happens next), not the admin form's "work has begun".
  await after('project mail', () => require('./emailController').sendReservationMail('package.purchase.received', { packageName: commercial.agreement.package?.name,
    order, walletPaid: purchase.walletPaid, upiPending: purchase.upiPending, invoiceNumber: invoice?.invoiceNumber }, fresh, `package-purchase-received:${order._id}`));
  await after('team notice', () => require('./emailController').sendReservationMail('package.purchase.admin', { packageName: commercial.agreement.package?.name,
    price: finalPrice, dueNow: purchase.dueNow, walletPaid: purchase.walletPaid, upiPending: purchase.upiPending,
    upiReference: purchase.upiPending > 0 ? upiReference : '' }, fresh, `package-purchase:${order._id}`));
  return { orderId: String(order._id), invoiceId: String(invoice._id), approved: order.orderVisibility === 'approved', reused: false, promoted,
    finalPrice, dueNow: purchase.dueNow, walletPaid: purchase.walletPaid, upiPending: purchase.upiPending };
}

module.exports = { purchasePackage, paymentInfo, quoteForPurchase, catalogueForCustomer, quoteForCustomer };
