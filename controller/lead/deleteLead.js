const leadModel = require("../../models/leadModel");

const deleteLeadController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { leadId } = req.params;

    const lead = await leadModel.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        message: "Lead not found",
        error: true,
        success: false,
      });
    }

    // Converted leads are the historical/audit trail behind a real client; deleting
    // one would drop that trail. Block it — the client (userModel) is untouched anyway.
    if (lead.convertedToUserId) {
      return res.status(409).json({
        message: "This lead is converted to a client and cannot be deleted",
        error: true,
        success: false,
      });
    }

    // Already trashed — nothing to do.
    if (lead.deletedAt) {
      return res.status(409).json({
        message: "This lead is already in Trash",
        error: true,
        success: false,
      });
    }

    // Soft-delete: move to Trash instead of hard-deleting. The record stays in the
    // collection but is hidden from every lead list/search (all filter deletedAt:null)
    // and is permanently purged 30 days later. Restore clears deletedAt back to null.
    lead.deletedAt = new Date();
    lead.deletedBy = req.userId;
    await lead.save();
    await require("../../helpers/finalMessageCycle").reconcileCycle(lead._id, { actor: req.userId });

    return res.json({
      message: "Lead moved to Trash",
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error deleting lead:", error);
    return res.status(400).json({
      message: error.message || "Failed to delete lead",
      error: true,
      success: false,
    });
  }
};

module.exports = deleteLeadController;
