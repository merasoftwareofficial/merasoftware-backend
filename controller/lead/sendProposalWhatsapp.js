const leadModel = require("../../models/leadModel");
const { hasEmail, queueProposalWhatsApp } = require("../../helpers/leadProposalMessage");

const reply = (res, status, message) => res.status(status).json({ message, error: status >= 400, success: status < 400 });

// The admin chose Send in the popup for a phone-only lead's proposal. One message per proposal version.
const sendProposalWhatsappController = async (req, res) => {
  let claimed = null;
  try {
    if (req.userRole !== "admin") return reply(res, 403, "Forbidden");
    const version = Number(req.params.version);
    const lead = await leadModel.findById(req.params.leadId);
    if (!lead) return reply(res, 404, "Lead not found");
    if (lead.convertedToUserId) return reply(res, 409, "This lead is already converted to a client and cannot be edited");
    if (hasEmail(lead)) return reply(res, 409, "This lead has an email; its message goes through email review");
    const proposal = (lead.proposals || []).find((item) => item.version === version);
    if (!proposal) return reply(res, 404, "Proposal not found");

    claimed = await leadModel.findOneAndUpdate(
      { _id: lead._id, proposals: { $elemMatch: { version, messageQueuedAt: null } } },
      { $set: { "proposals.$.messageQueuedAt": new Date() } },
      { timestamps: false },
    );
    if (!claimed) return reply(res, 409, "This proposal's message was already sent");

    await queueProposalWhatsApp(lead, proposal, req.body || {});
    return reply(res, 200, "WhatsApp message queued");
  } catch (error) {
    console.error("Error queueing proposal WhatsApp:", error);
    if (claimed) {
      await leadModel.updateOne(
        { _id: claimed._id, "proposals.version": Number(req.params.version) },
        { $set: { "proposals.$.messageQueuedAt": null } },
        { timestamps: false },
      ).catch(() => {});
    }
    return reply(res, error.status || 400, error.message || "Failed to queue the WhatsApp message");
  }
};

module.exports = sendProposalWhatsappController;
