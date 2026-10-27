const uploadProductPermission = require("../../helpers/permission");
const { retirePlan } = require("../../helpers/servicePlanLifecycle");

// One admin action, two safe outcomes — the server decides which, never the client:
// 0 purchases -> hard delete; 1+ purchases -> RETIRE (hidden, row kept for ever so paid invoices
// and order history keep their business record). Not the Trash system, which purges after 30 days.
// Rules: helpers/servicePlanLifecycle.js (shared with the website plan catalogue).
const retireOrDeletePlan = async (req, res) => {
  try {
    if (!(await uploadProductPermission(req.userId))) {
      return res.status(403).json({ message: "Permission denied", error: true, success: false });
    }
    const result = await retirePlan({ planId: req.params.planId || req.body?._id, actorId: req.userId });
    return res.json({ message: result.message, success: true, error: false, data: result.data });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      message: error.message || "Failed to remove the plan",
      error: true,
      success: false,
    });
  }
};

module.exports = retireOrDeletePlan;
