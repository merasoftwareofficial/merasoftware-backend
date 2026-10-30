const userModel = require("../../models/userModel");
const leadModel = require("../../models/leadModel");
const { expiryCutoff, daysLeft } = require("./trashConstants");
const { DEFAULT_LEAD_STATUS } = require("../../helpers/leadStatuses");

// Returns everything currently in Trash — soft-deleted clients + leads — merged and
// badge-tagged (type: "client" | "lead"), each with daysLeft before auto-purge.
// Lazy cleanup: any record already past its 30-day retention is permanently deleted
// here (no cron), so opening the Trash page is what actually purges expired records.
const getTrashController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({ message: "Forbidden", error: true, success: false });
    }

    // 1. Lazy purge: permanently remove records trashed before the retention cutoff.
    const cutoff = expiryCutoff();
    await Promise.all([
      userModel.deleteMany({ deletedAt: { $ne: null, $lt: cutoff } }),
      leadModel.deleteMany({ deletedAt: { $ne: null, $lt: cutoff } }),
    ]);

    // 2. List what remains in Trash.
    const [clients, leads] = await Promise.all([
      userModel
        .find({ roles: "customer", deletedAt: { $ne: null } })
        .select("name email phone deletedAt")
        .sort({ deletedAt: -1 })
        .lean(),
      leadModel
        .find({ deletedAt: { $ne: null } })
        .select("name email phone status deletedAt")
        .sort({ deletedAt: -1 })
        .lean(),
    ]);

    const clientResults = clients.map((c) => ({
      type: "client",
      _id: c._id,
      name: c.name || "",
      email: c.email || "",
      phone: c.phone || "",
      deletedAt: c.deletedAt,
      daysLeft: daysLeft(c.deletedAt),
    }));

    const leadResults = leads.map((l) => ({
      type: "lead",
      _id: l._id,
      name: l.name || "",
      email: l.email || "",
      phone: l.phone || "",
      status: l.status || DEFAULT_LEAD_STATUS,
      deletedAt: l.deletedAt,
      daysLeft: daysLeft(l.deletedAt),
    }));

    // Most recently trashed first across both types.
    const data = [...clientResults, ...leadResults].sort(
      (a, b) => new Date(b.deletedAt) - new Date(a.deletedAt)
    );

    return res.json({
      message: "Trash fetched",
      data,
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error fetching Trash:", error);
    return res.status(400).json({
      message: error.message || "Failed to fetch Trash",
      error: true,
      success: false,
    });
  }
};

module.exports = getTrashController;
