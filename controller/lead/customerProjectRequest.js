const leadModel = require("../../models/leadModel");
const userModel = require("../../models/userModel");
const { listProjectCategories } = require("../../helpers/projectCategories");
const { OPEN_LEAD_STATUSES } = require("../../helpers/leadStatuses");

// Portal "Get a Service" → "Start a Project": a client picks a project category, gives a budget,
// a time to call and a phone number (plus an optional note), and asks for a callback. The
// request is saved as a lead
// (source SOURCE, requestedByUserId = the client) so the team works it in the admin Leads list.
// Nothing is priced or ordered here; online orders stay in customerCreateCustomProjectOrder.js.

const SOURCE = "Portal – project request";
const REPEAT_WINDOW_MS = 10 * 60 * 1000;

// Both answers are required; the portal form (pages/StartProjectRequestDetails.js) uses the same keys.
const ANSWERS = {
  budget: { label: "Budget", options: { under_30k: "Under ₹30,000", "30k_1l": "₹30,000 – ₹1 lakh", above_1l: "Above ₹1 lakh", not_sure: "Not sure yet" } },
  callTime: { label: "Best time to call", options: { morning: "Morning", afternoon: "Afternoon", evening: "Evening", any: "Any time" } },
};
const DETAILS_MAX = 300;

const reply = (res, status, message, data) =>
  res.status(status).json({ message, success: status < 400, error: status >= 400, ...(data ? { data } : {}) });

// Categories a client can ask about: active and opened to customers. A price is not needed for a callback.
const requestCategories = async () =>
  (await listProjectCategories())
    .filter((entry) => entry.status === "active" && entry.customerSelectable)
    .map(({ category, label, description }) => ({ category, label, description: description || "" }));

const loadClient = async (userId) => {
  const user = userId && await userModel.findById(userId).select("name email phone roles isGuest").lean();
  return user && Array.isArray(user.roles) && user.roles.includes("customer") ? user : null;
};

const getProjectRequestCategories = async (req, res) => {
  try {
    if (!await loadClient(req.userId)) return reply(res, 403, "Only clients can start a project here.");
    return reply(res, 200, "Project request categories", await requestCategories());
  } catch (error) {
    console.error("Error fetching project request categories:", error);
    return reply(res, 500, "Could not load the project types. Please try again.");
  }
};

const cleanPhone = (value) => String(value || "").trim().replace(/\s+/g, " ");
const validPhone = (value) => /^\+?[0-9 -]{7,20}$/.test(value) && value.replace(/\D/g, "").length >= 7 && value.replace(/\D/g, "").length <= 15;

const noteFor = ({ user, category, phone, answers }) => {
  const lines = [
    "Project request from the client portal",
    `Client: ${user.name || "—"} <${user.email || "no email"}> (account ${user._id})`,
    `Project type: ${category.label}`,
    `Phone to call: ${phone}`,
    ...Object.entries(ANSWERS).map(([key, { label, options }]) => `${label}: ${options[answers[key]]}`),
  ];
  if (answers.details) lines.push(`What they need: ${answers.details}`);
  return lines.join("\n");
};

const createProjectRequest = async (req, res) => {
  try {
    const user = await loadClient(req.userId);
    if (!user) return reply(res, 403, "Only clients can start a project here.");

    const body = req.body || {};
    const category = (await requestCategories()).find((entry) => entry.category === body.category);
    if (!category) return reply(res, 400, "Please choose what you want to build.");

    const phone = cleanPhone(body.phone);
    if (!validPhone(phone)) return reply(res, 400, "Please enter a valid phone number so we can call you.");

    const answers = {};
    for (const [key, { label, options }] of Object.entries(ANSWERS)) {
      if (!Object.prototype.hasOwnProperty.call(options, body[key])) return reply(res, 400, `Please choose "${label}".`);
      answers[key] = body[key];
    }
    const details = String(body.details || "").trim();
    if (details.length > DETAILS_MAX) return reply(res, 400, `Please keep the description under ${DETAILS_MAX} characters.`);
    if (details) answers.details = details;
    const note = noteFor({ user, category, phone, answers });

    // One open request per client: a new request is added to it, and a repeat within
    // REPEAT_WINDOW_MS (a double click or a quick resend) changes nothing.
    const open = await leadModel
      .findOne({ requestedByUserId: user._id, deletedAt: null, status: { $in: OPEN_LEAD_STATUSES } })
      .sort({ updatedAt: -1 });
    if (open) {
      const own = (open.followUps || []).filter((item) => String(item.createdBy) === String(user._id)).map((item) => item.createdAt);
      const last = Math.max(new Date(open.createdAt).getTime(), ...own.map((date) => new Date(date).getTime()));
      if (Date.now() - last < REPEAT_WINDOW_MS) return reply(res, 200, "Request received", { phone, repeated: true });
      open.followUps.push({ note, badge: open.status, createdBy: user._id });
      await open.save();
      return reply(res, 200, "Request received", { phone, repeated: false });
    }

    await leadModel.create({
      name: user.name || user.email || "Portal client",
      phone,
      email: String(user.email || "").trim().toLowerCase(),
      source: SOURCE,
      notes: note,
      requestedByUserId: user._id,
      createdBy: user._id,
    });
    return reply(res, 201, "Request received", { phone, repeated: false });
  } catch (error) {
    console.error("Error saving project request:", error);
    return reply(res, 500, "Could not send your request. Please try again.");
  }
};

module.exports = { getProjectRequestCategories, createProjectRequest, SOURCE, REPEAT_WINDOW_MS };
