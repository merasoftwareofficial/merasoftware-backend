const { requireCategoryForNewProject } = require("../../helpers/projectCategories");

// Customer-safe, read-only base price for a single project category.
// The admin endpoint (getCategoryBasePrices.js) is admin-guarded and returns ALL
// categories for the admin config table; the customize form (StartNewWebsiteCustomize.js)
// only needs the base price for the one category it is estimating, and any authenticated
// customer may read it — so this is a separate, minimal, admin-flow-untouched endpoint.
// SSOT: the same customer rule customerCreateCustomProjectOrder.js enforces.
const getCustomerCategoryBasePrice = async (req, res) => {
  try {
    const { category } = req.query;
    const entry = await requireCategoryForNewProject(category, { customer: true });

    return res.json({
      message: "Category base price",
      success: true,
      error: false,
      data: { category: entry.category, basePrice: entry.basePrice },
    });
  } catch (error) {
    if (!error.statusCode) console.error("Error fetching customer category base price:", error);
    return res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : "Failed to fetch category base price",
      error: true,
      success: false,
    });
  }
};

module.exports = getCustomerCategoryBasePrice;
