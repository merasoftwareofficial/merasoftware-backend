const userModel = require("../../models/userModel");
const leadModel = require("../../models/leadModel");
const { DEFAULT_LEAD_STATUS } = require("../../helpers/leadStatuses");

const RESULT_LIMIT = 12;

// Escape user input so it is treated as literal text in the regex, not a pattern.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globalSearchController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const query = (req.query.q || "").trim();
    if (!query) {
      return res.json({
        message: "Empty query",
        data: [],
        success: true,
        error: false,
      });
    }

    const regex = new RegExp(escapeRegex(query), "i");
    const matchFields = [{ name: regex }, { email: regex }, { phone: regex }];

    const [clients, leads] = await Promise.all([
      userModel
        .find({ roles: "customer", deletedAt: null, $or: matchFields })
        .select("name email phone")
        .limit(RESULT_LIMIT)
        .lean(),
      // Hide converted leads: they already surface as a client result.
      // Hide trashed leads (deletedAt set): they live only in the Trash page.
      leadModel
        .find({ convertedToUserId: null, deletedAt: null, $or: matchFields })
        .select("name email phone status")
        .limit(RESULT_LIMIT)
        .lean(),
    ]);

    const clientResults = clients.map((client) => ({
      type: "client",
      _id: client._id,
      name: client.name || "",
      email: client.email || "",
      phone: client.phone || "",
    }));

    const leadResults = leads.map((lead) => ({
      type: "lead",
      _id: lead._id,
      name: lead.name || "",
      email: lead.email || "",
      phone: lead.phone || "",
      status: lead.status || DEFAULT_LEAD_STATUS,
    }));

    // Clients first, then leads.
    const data = [...clientResults, ...leadResults];

    return res.json({
      message: "Search results",
      data,
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error in global search:", error);
    return res.status(400).json({
      message: error.message || "Search failed",
      error: true,
      success: false,
    });
  }
};

module.exports = globalSearchController;
