const mongoose = require('mongoose');
const StartRequest = require('../models/packageStartRequestModel');
const User = require('../models/userModel');
const Lead = require('../models/leadModel');
const { readPackages, fail, quotePackageChoice } = require('./salesPackages');
const { parsePhone } = require('./phoneNumber');

// "Start my project" on a package page without a running offer (merasoftware/src/docs/package-offers.md,
// owner decisions 7 Nov 2026). The same steps as the offer card's Start (reservationStart.js), without a
// reservation: the person's one lead gets a follow-up line, the team and the customer get a message, and
// the team is reminded once a day (at most 3 times) until it creates the project or closes the request.
// Behind PACKAGE_START_REQUESTS_ENABLED until it is tested on a real phone.
const DAY = 24 * 3600000;
const MAX_ALERTS = 3;
const LOCK_MS = 2 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const enabled = () => process.env.PACKAGE_START_REQUESTS_ENABLED === 'true';
const safeId = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;

const requestView = row => row && ({
  id: String(row._id), packageId: row.packageId, title: row.packageSnapshot?.name || row.packageId,
  price: row.packageSnapshot?.price ?? null, category: row.packageSnapshot?.category || null, choice: row.packageSnapshot?.choice || null,
  quote: row.packageSnapshot?.quote || null, requestedAt: row.requestedAt, closedAt: row.closedAt || null,
  closedReason: row.closedReason || null, projectId: row.projectId ? String(row.projectId) : null,
  status: row.closedAt ? 'closed' : 'requested',
});

async function activeOwner(userId, session = null) {
  const user = await User.findById(userId).session(session);
  if (!user || user.isGuest || user.isActive === false || user.deletedAt) fail('An active permanent account is required', 403);
  return user;
}

async function listPackageStarts(userId) {
  await activeOwner(userId);
  const rows = await StartRequest.find({ userId }).sort({ requestedAt: -1 }).lean();
  return { requests: rows.map(requestView), enabled: enabled() };
}

// The customer's choice on the customize page (package.md §3), as the request stores it.
const choiceFromQuote = quote => (quote.billing === 'monthly'
  ? { billingCycle: quote.monthly.billingCycle, tenureMonths: quote.monthly.tenureMonths, files: quote.monthly.files, updates: quote.monthly.updatesPerMonth }
  : { paymentOption: quote.paymentOption });

async function requestPackageStart({ userId, packageId, choice, countryCode, phone }) {
  if (!enabled()) fail('Starting a project from a package is not enabled yet', 503);
  if (!safeId(packageId)) fail('Choose a package');
  const enteredPhone = phone ? parsePhone({ countryCode, phone }) : null;
  await activeOwner(userId);
  // A repeat click returns the open request; it never sends its messages again.
  const open = await StartRequest.findOne({ userId, packageId, closedAt: null }).lean();
  if (open) return { request: requestView(open), requested: false };
  const item = (await readPackages()).find(row => row.id === packageId && row.status === 'published');
  if (!item) fail('This package is not available.', 404);
  // A package with purchase settings is asked for with the customer's choice, priced by the one choice
  // quote (offer included). The price is a record of what the customer saw; the project is always priced
  // from the live package when the team creates it (projectPricing.js). Older packages keep their price.
  let quoted = null;
  if (item.billing) {
    if (!choice || typeof choice !== 'object') fail('Choose how you want to buy this package');
    quoted = quotePackageChoice(item, (await require('./websiteOffers').fetchWebsiteCatalogue()).offers, choice);
  }
  const price = quoted ? quoted.finalPrice : item.discountedPrice ?? item.regularPrice;
  const { isClient, ensureWonLead } = require('./wonLead');
  let created, client = false;
  try {
    await mongoose.connection.transaction(async session => {
      created = null;
      const user = await activeOwner(userId, session);
      // Owner rule: no lead without a phone. Older accounts add it here once (HTTP 428 asks for it).
      if (!user.phone) {
        if (!enteredPhone) fail('Add your mobile number to start your project', 428);
        user.phone = enteredPhone; user.phoneVerified = false;
        await user.save({ session });
      }
      // Serialize concurrent requests for one owner, so two requests cannot create two leads.
      await User.updateOne({ _id: userId }, { $inc: { __v: 1 } }, { session });
      client = isClient(user);
      // A member's one lead (helpers/personLead.js), as an offer reservation links it; a client's is set after the commit.
      let lead = null;
      if (!client) {
        lead = (await require('./personLead').linkPersonLead(user, { session, source: 'Package start request' })).lead;
        if (lead && !lead.phone) { lead.phone = user.phone; await lead.save({ session }); }
      }
      [created] = await StartRequest.create([{ userId, packageId, requestedAt: new Date(), leadId: lead?._id || null,
        packageSnapshot: { id: item.id, name: item.name, category: item.category, regularPrice: item.regularPrice, price,
          ...(quoted ? { billing: quoted.billing, choice: choiceFromQuote(quoted), quote: { finalPrice: quoted.finalPrice, dueNow: quoted.dueNow,
            offerSlug: quoted.offer?.slug || null, ...(quoted.monthly ? { cyclePrice: quoted.monthly.cyclePrice, totalCycles: quoted.monthly.totalCycles } : {}) } } : {}) } }], { session });
    });
  } catch (error) {
    // Two clicks at once: the unique open request lets one win; the other returns it.
    if (error.code !== 11000) throw error;
    const row = await StartRequest.findOne({ userId, packageId, closedAt: null }).lean();
    if (!row) throw error;
    return { request: requestView(row), requested: false };
  }
  try {
    // A client without a lead gets the Won lead every client has (wonLead.js), as reservationStart.js does.
    const lead = client ? await ensureWonLead(await User.findById(userId)) : await Lead.findById(created.leadId);
    if (lead) {
      const now = new Date();
      await Lead.updateOne({ _id: lead._id }, { $push: { followUps: { note: `Wants to start the project on the package ${item.name} `
        + `(₹${Number(price).toLocaleString('en-IN')}). Requested from the package page.`, badge: lead.status, date: now, createdAt: now } } });
      if (!created.leadId) await StartRequest.updateOne({ _id: created._id }, { $set: { leadId: lead._id } });
    }
  } catch (error) { console.error('[package start] lead follow-up:', error.message); }
  return { request: requestView(created.toObject()), requested: true };
}

async function messageContext(row, extra = {}) {
  const user = await User.findById(row.userId).lean();
  const fresh = await StartRequest.findById(row._id).lean();
  return { user, request: { ...row, leadId: fresh?.leadId || row.leadId, isClient: require('./wonLead').isClient(user), ...extra } };
}

// Sends each request's two messages once (dedupe keys). Called right after the request and by the job.
async function deliverPackageStartNotices({ requestId = null, now = new Date(), limit = 10 } = {}) {
  if (!enabled()) return [];
  const rows = await StartRequest.find({ ...(requestId ? { _id: requestId } : {}), noticesAt: null,
    $or: [{ noticeNextAttemptAt: null }, { noticeNextAttemptAt: { $lte: now } }] }).limit(limit).lean();
  const results = [];
  for (const row of rows) {
    // The lock: only one caller sends a request's messages at a time.
    const claimed = await StartRequest.updateOne({ _id: row._id, noticesAt: null, noticeNextAttemptAt: row.noticeNextAttemptAt ?? null },
      { $set: { noticeNextAttemptAt: new Date(now.getTime() + LOCK_MS) } });
    if (!claimed.modifiedCount) continue;
    try {
      const { user, request } = await messageContext(row);
      const send = require('./emailController').sendReservationMail;
      const team = await send('package.start.request.admin', request, user, `package-start-request:${row._id}`);
      const customer = user && !user.deletedAt && user.isActive !== false
        ? await send('package.start.request.received', request, user, `package-start-received:${row._id}`) : 'not-sent';
      await StartRequest.updateOne({ _id: row._id }, { $set: { noticesAt: new Date(), noticeFailure: '' } });
      results.push({ id: String(row._id), team, customer });
    } catch (error) {
      await StartRequest.updateOne({ _id: row._id }, { $set: { noticeFailure: error.message, noticeNextAttemptAt: new Date(now.getTime() + RETRY_MS) } });
      results.push({ id: String(row._id), failed: error.message });
    }
  }
  return results;
}

// A request nobody acted on: the team is told again after each full day, at most 3 times.
async function alertPendingPackageStarts({ now = new Date(), limit = 20 } = {}) {
  if (!enabled()) return [];
  const rows = await StartRequest.find({ closedAt: null, alerts: { $lt: MAX_ALERTS }, requestedAt: { $lte: new Date(now.getTime() - DAY) } })
    .sort({ requestedAt: 1 }).limit(limit).lean();
  const results = [];
  for (const row of rows) {
    const days = Math.floor((now - new Date(row.requestedAt)) / DAY);
    const alerts = row.alerts || 0;
    if (days <= alerts) continue;
    const claimed = await StartRequest.updateOne({ _id: row._id, closedAt: null, alerts }, { $set: { alerts: alerts + 1 } });
    if (!claimed.modifiedCount) continue;
    try {
      const { user, request } = await messageContext(row, { waitingDays: days });
      const status = await require('./emailController').sendReservationMail('package.start.request.admin', request, user,
        `package-start-pending:${row._id}:${alerts + 1}`);
      results.push({ id: String(row._id), alert: alerts + 1, status });
    } catch (error) {
      // Not sent: give the alert back so the next run tries again.
      await StartRequest.updateOne({ _id: row._id, alerts: alerts + 1 }, { $set: { alerts } });
      results.push({ id: String(row._id), alert: alerts + 1, failed: error.message });
    }
  }
  return results;
}

// Called inside the project-creation transaction: a project on this package closes the person's open request.
async function closeOnProject({ order, session }) {
  const packageId = order?.projectSnapshot?.salesAgreement?.package?.id;
  if (!packageId || !order.userId) return null;
  return StartRequest.updateOne({ userId: order.userId, packageId, closedAt: null },
    { $set: { closedAt: new Date(), closedReason: 'project_created', projectId: order._id } }, { session });
}

// The team closes a request by hand (the person no longer wants it, or it was handled another way).
async function closeByTeam({ requestId, actorId }) {
  if (!mongoose.isValidObjectId(requestId)) fail('Choose a request');
  const row = await StartRequest.findOneAndUpdate({ _id: requestId, closedAt: null },
    { $set: { closedAt: new Date(), closedReason: 'closed_by_team', closedBy: actorId } }, { new: true }).lean();
  if (!row) fail('This request is already closed or does not exist.', 409);
  return { request: requestView(row) };
}

module.exports = { requestPackageStart, listPackageStarts, deliverPackageStartNotices, alertPendingPackageStarts, closeOnProject, closeByTeam, requestView, MAX_ALERTS };
