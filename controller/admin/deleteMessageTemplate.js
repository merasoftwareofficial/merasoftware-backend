const mongoose = require("mongoose");
const messageTemplateModel = require("../../models/messageTemplateModel");

const deleteMessageTemplateController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { templateId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(400).json({
        message: "Valid templateId is required",
        error: true,
        success: false,
      });
    }

    const deleted = await messageTemplateModel.findOneAndDelete({ _id: templateId, purpose: { $ne: 'broadcast' } });

    if (!deleted) {
      return res.status(404).json({
        message: "Message template not found",
        error: true,
        success: false,
      });
    }

    return res.json({
      message: "Message template deleted",
      success: true,
      error: false,
      data: deleted,
    });
  } catch (error) {
    console.error("Error deleting message template:", error);
    return res.status(500).json({
      message: error.message || "Failed to delete message template",
      error: true,
      success: false,
    });
  }
};

module.exports = deleteMessageTemplateController;
