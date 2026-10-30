const leadModel = require("../../models/leadModel");

const getLeadsController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const leads = await leadModel
      .find({ deletedAt: null })
      .select("name phone email source status proposalSentAt convertedToUserId createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      message: "Leads fetched successfully",
      data: leads,
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error fetching leads:", error);
    return res.status(400).json({
      message: error.message || "Failed to fetch leads",
      error: true,
      success: false,
    });
  }
};

module.exports = getLeadsController;
