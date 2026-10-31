const leadModel = require("../../models/leadModel");
const { pendingLeads, prepareFor } = require("../../helpers/finalMessage");

const reply = (res, status, message, data) => res.status(status).json({ message, data, error: status >= 400, success: status < 400 });
const WHY_NOT = {
  "not-negative": "Only a Negative lead can get the final message.",
  unreachable: "This lead has no valid WhatsApp number or email.",
  client: "This number belongs to a client, so the final message is not for them.",
  "already-sent": "The final message has already gone to this person.",
  "in-review": "This lead's final message is already waiting for a decision.",
  unavailable: "The message could not be prepared: check the Final message action in Email Templates.",
};

// How many Negative leads the Leads page's button would prepare a message for.
const countController = async (req, res) => {
  try {
    if (req.userRole !== "admin") return reply(res, 403, "Forbidden");
    return reply(res, 200, "Final message count", { count: (await pendingLeads()).length });
  } catch (error) {
    console.error("Error counting final messages:", error);
    return reply(res, 400, error.message || "Failed to count");
  }
};

// The button: one draft per lead in this request; the portal's popup opens them one after another.
const prepareAllController = async (req, res) => {
  try {
    if (req.userRole !== "admin") return reply(res, 403, "Forbidden");
    let prepared = 0;
    for (const lead of await pendingLeads()) if (await prepareFor(lead) === "prepared") prepared += 1;
    return reply(res, 200, "Final messages prepared", { prepared });
  } catch (error) {
    console.error("Error preparing final messages:", error);
    return reply(res, 400, error.message || "Failed to prepare");
  }
};

// One lead's Send button, for a lead whose message wasn't sent when it was marked Negative.
const prepareOneController = async (req, res) => {
  try {
    if (req.userRole !== "admin") return reply(res, 403, "Forbidden");
    const lead = await leadModel.findById(req.params.leadId).lean();
    if (!lead) return reply(res, 404, "Lead not found");
    const outcome = await prepareFor(lead);
    return outcome === "prepared" ? reply(res, 200, "Final message prepared") : reply(res, 409, WHY_NOT[outcome]);
  } catch (error) {
    console.error("Error preparing the final message:", error);
    return reply(res, 400, error.message || "Failed to prepare");
  }
};

module.exports = { countController, prepareAllController, prepareOneController };
