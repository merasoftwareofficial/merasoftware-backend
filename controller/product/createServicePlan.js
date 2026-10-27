const { savePlan } = require('../../helpers/servicePlanCatalogue');

// Portal "Create Service" page. The rules live in helpers/servicePlanCatalogue.js, shared with the
// website admin plan form, so both create a plan the same way. This page has no category field,
// so the category is not required here.
const createServicePlanController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const savedPlan = await savePlan({ ...(req.body || {}), creating: true }, { requireCategory: false });
    return res.status(201).json({ message: "Service created successfully", error: false, success: true, data: savedPlan });
  } catch (error) {
    if (!error.statusCode) console.error("Error creating service:", error);
    return res.status(400).json({
      message: error.message || "Failed to create service",
      error: true,
      success: false,
    });
  }
};

module.exports = createServicePlanController;
