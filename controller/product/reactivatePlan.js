const uploadProductPermission = require("../../helpers/permission");
const { restorePlan } = require("../../helpers/servicePlanLifecycle");

// Undo a retirement: the plan returns to Active Plans and back on sale (a flexible plan stays
// hidden until the new builder is live). Rules: helpers/servicePlanLifecycle.js.
const reactivatePlan = async (req, res) => {
  try {
    if (!(await uploadProductPermission(req.userId))) {
      return res.status(403).json({ message: "Permission denied", error: true, success: false });
    }
    const result = await restorePlan({ planId: req.params.planId || req.body?._id });
    return res.json({ message: result.message, success: true, error: false, data: result.data });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      message: error.message || "Failed to reactivate the plan",
      error: true,
      success: false,
    });
  }
};

module.exports = reactivatePlan;
