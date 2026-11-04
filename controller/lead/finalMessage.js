const leadModel = require("../../models/leadModel");
const { pendingLeads, pendingClients, prepareFor } = require("../../helpers/finalMessage");

const reply = (res, status, message, data) => res.status(status).json({ message, data, error: status >= 400, success: status < 400 });
const WHY_NOT = {
  "not-negative": "Only a Negative lead can get the final message.",
  unreachable: "This lead has no valid WhatsApp number or email.",
  client: "This number belongs to a client, so the final message is not for them.",
  "client-ineligible": "Client final messages are unavailable, or this client's account, phone or behaviour needs review.",
  "already-sent": "The final message has already gone to this person.",
  "in-review": "This lead's final message is already waiting for a decision.",
  unavailable: "The message could not be prepared: check the Final message action in Email Templates.",
};

// How many Negative leads the Leads page's button would prepare a message for.
const countController = async (req, res) => {
  try {
    if (req.userRole !== "admin") return reply(res, 403, "Forbidden");
    const [leads, clients] = await Promise.all([pendingLeads("status phone email convertedToUserId requestedByUserId deletedAt"), pendingClients()]);
    return reply(res, 200, "Final message count", { count: leads.length, clientCount: clients.length });
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
    const leads = req.query?.scope === 'client' ? await pendingClients() : await pendingLeads();
    for (const lead of leads) if (await prepareFor(lead) === "prepared") prepared += 1;
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
    if (lead.convertedToUserId) {
      const readiness = await require('../../helpers/clientFinalMessageReadiness').clientStartReadiness(lead);
      if (!readiness.ready) return reply(res, 409, readiness.message, { finalMessageReadiness: readiness });
    }
    const outcome = await prepareFor(lead, { newEpisode: req.query?.new === '1' });
    return outcome === "prepared" ? reply(res, 200, "Final message prepared") : reply(res, 409, WHY_NOT[outcome]);
  } catch (error) {
    console.error("Error preparing the final message:", error);
    return reply(res, 400, error.message || "Failed to prepare");
  }
};

const stopController = async (req, res) => {
  try {
    if (req.userRole !== 'admin') return reply(res, 403, 'Forbidden');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 500) return reply(res, 400, 'Enter a reason between 1 and 500 characters.');
    if (!require('mongoose').isValidObjectId(req.body?.draftId)) return reply(res, 400, 'Refresh the page to load the current countdown.');
    const row = await require('../../whatsapp/src/models.js').FinalMessage.findOne({ leadId: req.params.leadId, draftId: req.body.draftId }).lean();
    if (!row) return reply(res, 409, 'This countdown changed. Refresh before stopping it.');
    const data = await require('../../helpers/stopFinalMessage').stopCycle(row, { reason, actor: req.userId });
    return reply(res, 200, 'Countdown stopped. Current status is unchanged.', data);
  } catch (error) { return reply(res, error.status || 400, error.message); }
};
module.exports = { countController, prepareAllController, prepareOneController, stopController };
