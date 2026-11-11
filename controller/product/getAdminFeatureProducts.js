const productModel = require("../../models/productModel");

const getAdminFeatureProductsController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const features = await productModel
      .find({ category: "feature_upgrades" })
      .select("_id serviceName price sellingPrice isHidden isQuantityBased formattedDescriptions packageIncludes keyBenefits compatibleWith terms createdAt updatedAt")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      message: "Admin feature products",
      success: true,
      error: false,
      data: features,
    });
  } catch (error) {
    console.error("Error fetching admin feature products:", error);
    return res.status(500).json({
      message: error.message || "Failed to fetch feature products",
      error: true,
      success: false,
    });
  }
};

module.exports = getAdminFeatureProductsController;
