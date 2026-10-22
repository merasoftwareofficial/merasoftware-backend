const { listProjectCategories } = require("../../helpers/projectCategories");

// Categories a customer can start a project in online: active, opened to customers and priced.
// Same rule as requireCategoryForNewProject(..., { customer: true }).
const getCustomerProjectCategories = async (req, res) => {
  try {
    const data = (await listProjectCategories())
      .filter((entry) => entry.status === "active" && entry.customerSelectable && entry.configured)
      .map(({ category, label, description, basePrice }) => ({ category, label, description, basePrice }));

    return res.json({
      message: "Project categories",
      success: true,
      error: false,
      data,
    });
  } catch (error) {
    console.error("Error fetching customer project categories:", error);
    return res.status(500).json({
      message: "Failed to fetch project categories",
      error: true,
      success: false,
    });
  }
};

module.exports = getCustomerProjectCategories;
