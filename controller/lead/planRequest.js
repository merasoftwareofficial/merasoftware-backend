const leadModel = require("../../models/leadModel");
const userModel = require("../../models/userModel");
const Product = require("../../models/productModel");
const { quoteServicePlan } = require("../../helpers/servicePlanPricing");
const { ON_SALE } = require("../../helpers/servicePlanPublicCatalogue");
const { requireIntegration } = require("../../helpers/integrationAuth");
const { parsePhone } = require("../../helpers/phoneNumber");
const { prepareTemplatedMail } = require("../../helpers/emailService");

// Website plan page (merasoftware/src/app/plans/[plan]) → "Get this plan" by someone who is not a
// portal client. Clients buy in the portal; everyone else asks, and the team calls them back.
// The request is saved as a lead (source SOURCE) with the plan and the exact choice in a follow-up,
// so the team sees it in the admin Leads list. Nothing is priced, ordered or paid here.
//
// Two doors, one rule:
//   POST  /api/plan-request               signed-in website member (cookie, authToken)
//   PATCH /api/integration/plan-request   visitor, sent by the website server (bearer, integrationAuth)
//
// One lead per person: a member's account already owns at most one lead (leadModel
// reservationUserId is unique, shared with offer reservations, helpers/offerReservations.js); a
// visitor's open lead is found by phone. A new request is added to that lead as a follow-up, and a
// repeat within REPEAT_WINDOW_MS (a double click or a quick resend) changes nothing.
// Mail: plan.request.admin + plan.request.received are customer-started (helpers/emailCatalog.js),
// so they send only while an admin has turned them On in Communication.

const SOURCE = "Website – plan request";
const NOTE_TITLE = "Plan request from the website";
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const OPEN_STATUSES = ["New", "Contacted"];
const PERIOD_WORDS = { monthly: "monthly", quarterly: "every 3 months", half_yearly: "every 6 months", yearly: "yearly" };

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;

// The plan on sale and the backend's own quote for the choice; anything the plan does not offer is refused.
async function quotedChoice(body = {}) {
  const plan = await Product.findOne({ ...ON_SALE, _id: body.planId }).lean().catch(() => null);
  if (!plan) fail("This plan is not available", 404);
  const quote = quoteServicePlan(plan, {
    purchase: body.purchase, tenureMonths: body.tenureMonths, files: body.files, updates: body.updates, releaseMode: body.releaseMode,
  });
  return { plan, quote };
}

// "20 files × 2 updates a month, every 3 months for 6 months" and the price as the page showed it.
function choiceText(plan, quote) {
  const oneTime = quote.purchase === "one_time";
  const what = plan.servicePlan?.pricingMode === "flexible"
    ? `${quote.files} files × ${quote.updates} update${quote.updates === 1 ? "" : "s"}${oneTime ? "" : " a month"}, ` : "";
  const how = oneTime ? "one-time" : `${PERIOD_WORDS[quote.purchase]} for ${quote.tenureMonths} month${quote.tenureMonths === 1 ? "" : "s"}`;
  const release = !oneTime && quote.releaseMode === "monthly" ? ", updates open month by month" : "";
  const price = oneTime
    ? `${money(quote.firstPayment)} one-time`
    : `${money(quote.firstPayment)} ${PERIOD_WORDS[quote.purchase]} (${quote.totalCycles} payment${quote.totalCycles === 1 ? "" : "s"}, ${money(quote.totalPrice)} in total)`;
  return { choice: `${what}${how}${release}`, price };
}

const noteFor = ({ plan, quote, contact, account }) => {
  const { choice, price } = choiceText(plan, quote);
  return [
    NOTE_TITLE,
    `Plan: ${plan.serviceName} (${plan._id})`,
    `Choice: ${choice}`,
    `Price shown: ${price}`,
    `Contact: ${contact.name} <${contact.email || "no email"}>, ${contact.phone}`,
    account ? `Website account: ${account}` : "Not signed in",
  ].join("\n");
};

// Last time this lead got a plan request (its creation, or a plan-request follow-up).
const lastRequestAt = (lead) => Math.max(
  new Date(lead.createdAt).getTime(),
  ...(lead.followUps || []).filter((item) => String(item.note || "").startsWith(NOTE_TITLE)).map((item) => new Date(item.createdAt).getTime()),
);

// Adds the request to `lead` (a follow-up), or does nothing on a quick repeat. Returns whether it was a repeat.
async function addToLead(lead, note, createdBy) {
  if (Date.now() - lastRequestAt(lead) < REPEAT_WINDOW_MS) return true;
  lead.followUps.push({ note, badge: lead.status, createdBy: createdBy || undefined });
  await lead.save();
  return false;
}

// The two mails' data (helpers/emailDefinitions.js plan.request.*): who asked, which plan, what choice.
async function notify({ lead, plan, quote, contact }) {
  const request = { lead, planName: plan.serviceName, contact, ...choiceText(plan, quote) };
  await prepareTemplatedMail("plan.request.admin", request);
  await prepareTemplatedMail("plan.request.received", request);
}

const respond = (fn) => async (req, res) => {
  try {
    const data = await fn(req);
    res.set("Cache-Control", "no-store").status(data.created ? 201 : 200).json({ success: true, error: false, message: "Request received", data: { repeated: data.repeated } });
  } catch (error) {
    if (!error.statusCode) console.error("Error saving plan request:", error);
    res.status(error.statusCode || 500).json({ success: false, error: true, message: error.statusCode ? error.message : "Could not send your request. Please try again." });
  }
};

// Signed-in website member (not a client: clients buy in the portal). Phone comes from the account;
// an older account without one adds it here once (same rule as offer reservations).
const memberPlanRequest = respond(async (req) => {
  const body = req.body || {};
  const user = req.userId && await userModel.findById(req.userId);
  if (!user || user.isGuest || user.isActive === false) fail("Please sign in again.", 401);
  if (user.roles?.includes("customer")) fail("You are already a client. Open this plan in your client portal to buy it.", 409);
  if (!user.roles?.includes("member")) fail("Plan requests are for website members.", 403);
  const { plan, quote } = await quotedChoice(body);
  if (!user.phone) {
    if (!body.phone) fail("Add your mobile number so our team can call you", 428);
    user.phone = parsePhone({ countryCode: body.countryCode, phone: body.phone });
    user.phoneVerified = false;
    await user.save();
  }
  const contact = { name: user.name || user.email, email: user.email, phone: user.phone };
  const note = noteFor({ plan, quote, contact, account: `${user.email} (${user._id})` });

  let lead = await leadModel.findOne({ reservationUserId: user._id });
  if (lead?.deletedAt || lead?.convertedToUserId) fail("Your earlier request is with our team. Please contact us directly.", 409);
  let created = false;
  if (!lead) {
    try {
      lead = await leadModel.create({ name: contact.name, email: contact.email, phone: contact.phone, source: SOURCE, notes: note, status: "New", reservationUserId: user._id, createdBy: user._id });
      created = true;
    } catch (error) {
      // Two requests at once: the unique reservationUserId index lets one create win.
      if (error.code !== 11000) throw error;
      lead = await leadModel.findOne({ reservationUserId: user._id });
    }
  }
  const repeated = created ? false : await addToLead(lead, note, user._id);
  if (!repeated) await notify({ lead, plan, quote, contact });
  return { created, repeated };
});

// Visitor (no account), sent by the website server after its own same-origin check.
const integrationPlanRequest = respond(async (req) => {
  requireIntegration(req);
  // Lets this request's own two mails pass the mail gate without a signed-in actor (helpers/emailController.js).
  req.planRequestIntake = true;
  const body = req.body || {};
  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  const email = String(body.email || "").trim().toLowerCase();
  if (name.length < 2 || name.length > 80) fail("Please enter your name");
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 120) fail("Please enter a valid email address");
  const phone = parsePhone({ countryCode: body.countryCode, phone: body.phone });
  const { plan, quote } = await quotedChoice(body);
  const contact = { name, email, phone };
  const note = noteFor({ plan, quote, contact });

  const open = await leadModel
    .findOne({ phone, deletedAt: null, convertedToUserId: null, status: { $in: OPEN_STATUSES } })
    .sort({ updatedAt: -1 });
  if (open) {
    const repeated = await addToLead(open, note);
    if (!repeated) await notify({ lead: open, plan, quote, contact });
    return { created: false, repeated };
  }
  const lead = await leadModel.create({ name, email, phone, source: SOURCE, notes: note, status: "New" });
  await notify({ lead, plan, quote, contact });
  return { created: true, repeated: false };
});

module.exports = { memberPlanRequest, integrationPlanRequest, choiceText, SOURCE, NOTE_TITLE, REPEAT_WINDOW_MS };
