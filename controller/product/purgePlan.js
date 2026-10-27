const uploadProductPermission = require("../../helpers/permission");
const { purgePlan: purge } = require("../../helpers/servicePlanLifecycle");

// "Delete Forever" — only for a plan that is ALREADY RETIRED. Default = archive (row kept, so
// every order, invoice and transaction stays whole); `mode: "hard"` removes the row and needs the
// plan's exact name typed. Rules: helpers/servicePlanLifecycle.js.
const purgePlan = async (req, res) => {
  try {
    if (!(await uploadProductPermission(req.userId))) {
      return res.status(403).json({ message: "Permission denied", error: true, success: false });
    }
    const result = await purge({
      planId: req.params.planId || req.body?._id,
      mode: req.body?.mode === "hard" ? "hard" : "archive",
      confirmName: req.body?.confirmName,
      actorId: req.userId,
    });
    return res.json({ message: result.message, success: true, error: false, data: result.data });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      message: error.message || "Failed to delete the plan",
      error: true,
      success: false,
    });
  }
};

module.exports = purgePlan;
