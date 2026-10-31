const userModel = require("../../models/userModel");
const leadModel = require("../../models/leadModel");
const offerTargetModel = require("../../models/offerTargetModel");

// Permanently delete a single trashed record ("Delete Forever"). Only records already
// in Trash (deletedAt set) can be purged — this is irreversible. type = "client" | "lead".
const purgeTrashController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({ message: "Forbidden", error: true, success: false });
    }

    const { type, id } = req.params;
    const model = type === "client" ? userModel : type === "lead" ? leadModel : null;
    if (!model) {
      return res.status(400).json({ message: "Invalid type", error: true, success: false });
    }

    const record = await model.findById(id).select("deletedAt");
    if (!record || !record.deletedAt) {
      return res.status(404).json({
        message: "Record not found in Trash",
        error: true,
        success: false,
      });
    }

    await model.findByIdAndDelete(id);
    if (type === "lead") await offerTargetModel.deleteMany({ leadId: id });

    return res.json({ message: "Permanently deleted", success: true, error: false });
  } catch (error) {
    console.error("Error purging from Trash:", error);
    return res.status(400).json({
      message: error.message || "Failed to delete permanently",
      error: true,
      success: false,
    });
  }
};

module.exports = purgeTrashController;
