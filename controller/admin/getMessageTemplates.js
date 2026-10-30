const messageTemplateModel = require("../../models/messageTemplateModel");

const getMessageTemplatesController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const data = await messageTemplateModel.find({ purpose: { $ne: 'broadcast' } }).sort({ createdAt: 1 }).lean();

    return res.json({
      message: "Message templates",
      success: true,
      error: false,
      data,
    });
  } catch (error) {
    console.error("Error fetching message templates:", error);
    return res.status(500).json({
      message: error.message || "Failed to fetch message templates",
      error: true,
      success: false,
    });
  }
};

module.exports = getMessageTemplatesController;
