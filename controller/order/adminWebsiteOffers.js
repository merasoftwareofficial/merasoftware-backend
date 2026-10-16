const userModel = require("../../models/userModel");
const { fetchLiveWebsiteOffers } = require("../../helpers/websiteOffers");

// Live website offers for the admin "Create Project" form's optional Offer dropdown.
const adminWebsiteOffersController = async (req, res) => {
  try {
    const adminUser = await userModel.findById(req.userId).select("roles");
    if (req.userRole !== "admin" || !adminUser?.roles?.includes("admin")) {
      return res.status(403).json({ message: "Forbidden", error: true, success: false });
    }

    const offers = await fetchLiveWebsiteOffers();
    return res.status(200).json({ success: true, error: false, data: offers });
  } catch (error) {
    console.error("Error loading website offers:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to load website offers",
      error: true,
      success: false,
    });
  }
};

module.exports = adminWebsiteOffersController;
