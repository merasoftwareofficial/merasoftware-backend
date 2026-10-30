const mongoose = require("mongoose");
const messageTemplateModel = require("../../models/messageTemplateModel");

const updateMessageTemplateController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { templateId } = req.params;
    const { message } = req.body;

    if (!mongoose.Types.ObjectId.isValid(templateId)) {
      return res.status(400).json({
        message: "Valid templateId is required",
        error: true,
        success: false,
      });
    }

    if (!message?.trim()) {
      return res.status(400).json({
        message: "Message is required",
        error: true,
        success: false,
      });
    }

    const updated = await messageTemplateModel.findOneAndUpdate(
      { _id: templateId, purpose: { $ne: 'broadcast' } },
      { message },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({
        message: "Message template not found",
        error: true,
        success: false,
      });
    }

    return res.json({
      message: "Message template updated",
      success: true,
      error: false,
      data: updated,
    });
  } catch (error) {
    console.error("Error updating message template:", error);
    return res.status(500).json({
      message: error.message || "Failed to update message template",
      error: true,
      success: false,
    });
  }
};

module.exports = updateMessageTemplateController;
