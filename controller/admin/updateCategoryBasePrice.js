const { saveProjectCategory } = require("../../helpers/projectCategories");

// Create a project category ({ creating: true, category, label, ... }) or update the fields sent.
const updateCategoryBasePriceController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const data = await saveProjectCategory(req.body, req.userId);

    return res.json({
      message: req.body?.creating === true ? "Project category created" : "Project category saved",
      success: true,
      error: false,
      data,
    });
  } catch (error) {
    if (!error.statusCode) console.error("Error saving project category:", error);
    return res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to save project category",
      error: true,
      success: false,
    });
  }
};

module.exports = updateCategoryBasePriceController;
