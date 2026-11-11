const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const User = require('../models/userModel');
const Order = require('../models/orderProductModel');
const { readPackages, quotePackage, quoteChoice, fail } = require('./salesPackages');
const { fetchWebsiteCatalogue } = require('./websiteOffers');
const { requireCategoryForNewProject } = require('./projectCategories');
const { resolveProjectPricing } = require('./projectPricing');
const { buildInstallments } = require('./projectInstallments');
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

// A package the customer already bought (owner decision 11 Nov 2026): while a project from it is still running, buying
// it again needs the customer's own "yes, a second one" (confirmRepeat), so a confused repeat click never makes a
// second project. Running = not cancelled, not payment-rejected, not completed; a deleted project is gone from Orders.
// One rule for the purchase, the "Proceed to pay" start request and the page that asks before paying.
// A monthly package runs as a plan (packagePlanOrder.js): running = its plan is active, paused for a bill, or waiting.
const RUNNING_PLAN = ['active', 'paused', 'pending_activation'];
const ACTIVE_PACKAGE_ORDER = idMatch => ({ orderVisibility: { $nin: ['cancelled', 'payment-rejected'] }, $or: [
  { 'projectSnapshot.salesAgreement.package.id': idMatch, status: { $ne: 'completed' } },
  { 'salesPackage.package.id': idMatch, isServicePlan: true, servicePlanStatus: { $in: RUNNING_PLAN } }] });
const { packageIdOf } = require('./packagePlanOrder');
const projectView = order => ({ orderId: String(order._id), packageId: packageIdOf(order),
  name: order.projectSnapshot?.displayName || order.projectSnapshot?.salesAgreement?.package?.name || order.salesPackage?.package?.name || 'Project',
  boughtAt: order.createdAt || null, approved: order.orderVisibility === 'approved', plan: order.isServicePlan === true });
const VIEW_FIELDS = 'projectSnapshot salesPackage isServicePlan orderVisibility createdAt';
async function activePackageProject(userId, packageId, session = null) {
  const order = await Order.findOne({ userId, ...ACTIVE_PACKAGE_ORDER(packageId) }).sort({ createdAt: -1 })
    .select(VIEW_FIELDS).session(session).lean();
  return order ? projectView(order) : null;
}
// The customer's running package projects and monthly package plans, one per package (the newest), for the page to ask before paying.
async function activePackageProjects(userId) {
  const orders = await Order.find({ userId, ...ACTIVE_PACKAGE_ORDER({ $type: 'string' }) })
    .sort({ createdAt: -1 }).select(VIEW_FIELDS).lean();
  const seen = new Set();
  return orders.map(projectView).filter(row => row.packageId && !seen.has(row.packageId) && seen.add(row.packageId));
}
const alreadyBought = project => Object.assign(
  new Error(`You already bought ${project.name}. Buying it again makes a second project; open your project in the portal, or confirm to buy another one.`),
  { statusCode: 409, code: 'package_already_bought', details: { project } });

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

// The portal's "Start a Project" list (owner decisions 10 + 11 Nov 2026): the published one-time and monthly packages a signed-in
// customer can buy, each with the price the purchase would charge. It reads the same quote as the purchase, so
// the list, the choice quote and the payment can never disagree. Nothing internal (service references, frozen
// add-on pricing, page design) is sent. While the package start system is off the list is empty, and the portal
// shows only its call-back form.
async function catalogueForCustomer(userId) {
  await activeAccount(userId);
  if (!enabled()) return { enabled: false, packages: [] };
  const offers = (await fetchWebsiteCatalogue()).offers;
  const packages = (await readPackages())
    .filter(item => item.status === 'published' && (item.billing === 'one_time' || item.billing === 'monthly'))
    .map(item => {
      const { quote } = quotePackage(item, offers);
      // A monthly package (owner decision 11 Nov 2026): price is per month; the customer picks a cycle and a length.
      return { id: item.id, name: item.name, description: item.description, category: item.category, billing: item.billing,
        portalUploads: item.portalUploads, paymentOptions: item.paymentOptions, inclusions: item.inclusions, terms: quote.terms,
        ...(item.billing === 'monthly' ? { monthly: { billingOptions: item.monthly.billingOptions, maxTenureMonths: item.monthly.maxTenureMonths,
          uploadsPerMonth: item.portalUploads ? (item.monthly.uploadsPerMonth ?? null) : null } } : {}),
        mainPrice: item.regularPrice, price: quote.finalPrice, discountAmount: quote.discountAmount,
        offer: quote.offer ? { title: quote.offer.title, endsAt: quote.offer.endsAt } : null };
    });
  // `serverNow`: the portal's offer countdown runs on this clock, not on the visitor's device (as MyOffers does).
  return { enabled: true, serverNow: new Date().toISOString(), packages };
}

// The price of one choice on one package: the quote the purchase checks (quoteKey and dueNow come from here).
async function quoteForCustomer(userId, packageId, choice) {
  await activeAccount(userId);
  if (!enabled()) fail('Starting a project from a package is not enabled yet', 503);
  const item = await publishedPackage(packageId);
  return (await quoteForPurchase(item, choice)).priced;
}

// `schedule` runs the after-commit work (Won lead, customer mail, team notice). The route sends the answer first and
// runs it right after (routes/packageStarts.js), so a slow mail never makes the customer's payment look failed;
// by default (tests, scripts) it is awaited here.
async function purchasePackage({ userId, packageId, choice, quoteKey, dueNow, creationKey, countryCode, phone, upiTransactionId, confirmRepeat = false },
  { schedule = work => work() } = {}) {
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
  const installmentCount = !monthly && priced.installments?.length ? priced.installments.length : 0;
  const isPartialPayment = installmentCount > 0;
  const startingNodeTitle = categoryEntry.startingNodeTitle || DEFAULT_STARTING_NODE_TITLE;
  const creationHash = createHash('sha256').update(JSON.stringify({ userId: String(userId), packageId, choice, quoteKey })).digest('hex');

  // A UPI remainder needs the customer's reference; its evidence (12+ digits, never used before) is checked
  // before anything is written. The wallet is read again inside the transaction, where the split is final.
  const balanceBefore = Number(user.walletBalance || 0);
  const upiReference = String(upiTransactionId || '').trim();
  const needsUpi = cents(balanceBefore) < cents(priced.dueNow);
  if (needsUpi && !upiReference) fail('UPI transaction ID is required for the amount not covered by the wallet');
  const transactionId = `PKG${new mongoose.Types.ObjectId()}`;
  // The same request sent again (a retry after a slow answer) is answered with its project below, so its UPI
  // reference, recorded the first time, is not checked again as a new one.
  const projectCreationKey = `${userId}:${creationKey}`;
  const sameRequest = await Order.exists({ projectCreationKey });
  // A package already running for this customer: asked before the UPI reference is checked, so the customer sees the
  // question, not "already recorded". Checked again inside the transaction, where it is final.
  if (!sameRequest && !confirmRepeat) {
    const running = await activePackageProject(userId, packageId);
    if (running) throw alreadyBought(running);
  }
  const preparedEvidence = needsUpi && !sameRequest ? await prepareUpiPaymentEvidence({ reference: upiReference, transactionId, capturedVia: 'customer' }) : null;

  // A monthly package is sold as a plan (packagePlanOrder.js): the first cycle is paid now, the plan engine bills the rest.
  if (monthly) {
    return purchaseMonthlyPackage({ userId, packageId, item, commercial, projectCreationKey, creationHash, confirmRepeat, enteredPhone,
      upiReference, transactionId, preparedEvidence }, { schedule });
  }

  const orderData = {
    paymentPolicy: commercial.paymentPolicy || null,
    projectCreationKey, projectCreationHash: creationHash,
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
  if (installmentCount) orderData.installments = buildInstallments(finalPrice, installmentCount);

  let promoted = false;
  const { order, invoice, reused, purchase } = await persistAdminProject({
    orderData, startingNodeTitle, actorId: userId, clientPurchase: true,
    sourceOffer: commercial.sourceOffer, sourceReservationId: commercial.sourceReservationId,
    // One purchase at a time per customer (the lock other package and offer requests use), then the final check.
    async beforeCreate({ session }) {
      await User.updateOne({ _id: userId }, { $inc: { __v: 1 } }, { session });
      if (!confirmRepeat) {
        const running = await activePackageProject(userId, packageId, session);
        if (running) throw alreadyBought(running);
      }
    },
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
  const after = async (label, work) => { try { await work(); } catch (error) { console.error(`[package purchase] ${label}:`, error.message); } };
  await schedule(async () => {
    const fresh = await User.findById(userId);
    if (promoted) await after('Won lead', () => require('./wonLead').ensureWonLead(fresh));
    // The customer's mail is the package purchase one (it says what happens next), not the admin form's "work has begun".
    await after('project mail', () => require('./emailController').sendReservationMail('package.purchase.received', { packageName: commercial.agreement.package?.name,
      order, walletPaid: purchase.walletPaid, upiPending: purchase.upiPending, invoiceNumber: invoice?.invoiceNumber }, fresh, `package-purchase-received:${order._id}`));
    await after('team notice', () => require('./emailController').sendReservationMail('package.purchase.admin', { packageName: commercial.agreement.package?.name,
      price: finalPrice, dueNow: purchase.dueNow, walletPaid: purchase.walletPaid, upiPending: purchase.upiPending,
      upiReference: purchase.upiPending > 0 ? upiReference : '' }, fresh, `package-purchase:${order._id}`));
  });
  return { orderId: String(order._id), invoiceId: String(invoice._id), approved: order.orderVisibility === 'approved', reused: false, promoted,
    finalPrice, dueNow: purchase.dueNow, walletPaid: purchase.walletPaid, upiPending: purchase.upiPending };
}

// The monthly package purchase: the same checks as above, then one plan order with its first-cycle bill and payment.
async function purchaseMonthlyPackage({ userId, packageId, item, commercial, projectCreationKey, creationHash, confirmRepeat, enteredPhone,
  upiReference, transactionId, preparedEvidence }, { schedule }) {
  const { buildPackagePlanOrderData, persistPackagePlanOrder, startPaidPackagePlan } = require('./packagePlanOrder');
  const orderData = { ...buildPackagePlanOrderData({ userId, item, commercial }), projectCreationKey, projectCreationHash: creationHash };
  let promoted = false;
  const { order, invoice, reused, walletPaid, upiPending } = await persistPackagePlanOrder({
    orderData, actorId: userId, clientPurchase: true, sourceOffer: commercial.sourceOffer, sourceReservationId: commercial.sourceReservationId,
    payment: { kind: 'customer', upiReference, transactionId, preparedEvidence },
    async beforeCreate({ client, session }) {
      await User.updateOne({ _id: userId }, { $inc: { __v: 1 } }, { session });
      if (!confirmRepeat) {
        const running = await activePackageProject(userId, packageId, session);
        if (running) throw alreadyBought(running);
      }
      if (!client.phone) { client.phone = enteredPhone; client.phoneVerified = false; }
      // Paying for a package makes a member a client, in this same transaction (clientAccount.js).
      if (!(client.roles || []).includes('customer')) { await promoteMemberToClient(client, { session }); promoted = true; }
      else if (client.isModified('phone')) await client.save({ session });
    },
  });
  if (reused) return { orderId: String(order._id), approved: order.orderVisibility === 'approved', reused: true, promoted: false, plan: true };
  // A wallet-paid first bill starts cycle 1 now; a UPI part starts it when the admin approves it.
  const started = await startPaidPackagePlan({ order, invoice });
  const after = async (label, work) => { try { await work(); } catch (error) { console.error(`[package purchase] ${label}:`, error.message); } };
  // The plan's own mails, as for any plan bought (customerCreateServicePlanOrder.js): "payment submitted" for a UPI
  // part and the team's notice. A paid cycle already told the customer (settleServiceCycle → plan mails).
  await schedule(async () => {
    const fresh = await User.findById(userId);
    if (promoted) await after('Won lead', () => require('./wonLead').ensureWonLead(fresh));
    await after('plan mails', () => require('./servicePlanNotifications').preparePurchaseMails(order._id, { walletPaid, upiPending, upiReference: upiPending > 0 ? upiReference : '' }));
  });
  return { orderId: String(order._id), invoiceId: String(invoice._id), approved: started.orderVisibility === 'approved', reused: false, promoted, plan: true,
    finalPrice: commercial.finalPrice, dueNow: order.totalAmount, walletPaid, upiPending };
}

module.exports = { purchasePackage, paymentInfo, quoteForPurchase, catalogueForCustomer, quoteForCustomer, activePackageProject, activePackageProjects, alreadyBought };
