const userModel = require("../../models/userModel");
const leadModel = require("../../models/leadModel");
const { FinalMessage } = require("../../whatsapp/src/models.js");
const { LABELS, MESSAGES, blockForLead } = require("../../helpers/leadContactBlock");
const { targetsForLead } = require("../../helpers/offerTargets");

const getLeadDetailController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { leadId } = req.params;

    const lead = await leadModel
      .findOne({ _id: leadId, deletedAt: null })
      .populate("followUps.createdBy", "name email")
      .populate("referredByUserId", "name phone email")
      .lean();

    if (!lead) {
      return res.status(404).json({
        message: "Lead not found",
        error: true,
        success: false,
      });
    }

    const [finalMessage, blocked, offerTargets, clientAvailable] = await Promise.all([
      FinalMessage.findOne({ leadId: lead._id }).select("status sentAt deadlineAt lastReplyText replySeenAt decision").lean(),
      blockForLead(lead),
      targetsForLead(lead._id),
      lead.convertedToUserId ? userModel.exists({ _id: lead.convertedToUserId, deletedAt: null, isGuest: { $ne: true }, roles: "customer" }) : null,
    ]);
    lead.finalMessage = finalMessage;
    lead.contactBlock = blocked ? { reason: blocked, label: LABELS[blocked], message: MESSAGES[blocked] } : null;
    lead.offerTargets = offerTargets;
    lead.clientAvailable = Boolean(clientAvailable);

    return res.json({
      message: "Lead fetched successfully",
      data: lead,
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error fetching lead detail:", error);
    return res.status(400).json({
      message: error.message || "Failed to fetch lead",
      error: true,
      success: false,
    });
  }
};

module.exports = getLeadDetailController;
