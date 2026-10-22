const { listProjectCategories, categoryUsage } = require("../../helpers/projectCategories");

// Admin list of every project category (archived included) with where each one is used.
const getCategoryBasePricesController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const [categories, usage] = await Promise.all([listProjectCategories(), categoryUsage()]);
    const data = categories.map((entry) => ({
      ...entry,
      usage: usage[entry.category] || { projects: 0, features: 0, packages: 0 },
    }));

    return res.json({
      message: "Project categories",
      success: true,
      error: false,
      data,
    });
  } catch (error) {
    console.error("Error fetching project categories:", error);
    return res.status(500).json({
      message: error.message || "Failed to fetch project categories",
      error: true,
      success: false,
    });
  }
};

module.exports = getCategoryBasePricesController;
