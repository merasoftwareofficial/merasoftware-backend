const userModel = require("../../models/userModel");
const leadModel = require("../../models/leadModel");
const { DEFAULT_LEAD_STATUS } = require("../../helpers/leadStatuses");
const { searchPatterns } = require("../../helpers/searchText");
const { clientLeadExtras } = require("../../helpers/wonLead");

const RESULT_LIMIT = 12;

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

    const { text, phone } = searchPatterns(query);
    const accountFields = [{ name: text }, { email: text }, { phone }];
    // A lead also matches on its business name and alternate number.
    const leadFields = [...accountFields, { businessName: text }, { altPhone: phone }];

    const [matchedClients, leads, clientLeads] = await Promise.all([
      userModel
        .find({ roles: "customer", deletedAt: null, $or: accountFields })
        .select("name email phone")
        .limit(RESULT_LIMIT)
        .lean(),
      // Hide converted leads: they already surface as a client result.
      // Hide trashed leads (deletedAt set): they live only in the Trash page.
      leadModel
        .find({ convertedToUserId: null, deletedAt: null, $or: leadFields })
        .select("name businessName email phone altPhone status")
        .limit(RESULT_LIMIT)
        .lean(),
      // A client's business name and alternate number are on their lead: a match there finds the client.
      leadModel
        .find({ convertedToUserId: { $ne: null }, deletedAt: null, $or: [{ businessName: text }, { altPhone: phone }] })
        .select("convertedToUserId")
        .limit(RESULT_LIMIT)
        .lean(),
    ]);

    const foundIds = new Set(matchedClients.map((client) => String(client._id)));
    const moreIds = [...new Set(clientLeads.map((lead) => String(lead.convertedToUserId)))].filter((id) => !foundIds.has(id));
    const moreClients = moreIds.length
      ? await userModel.find({ _id: { $in: moreIds }, roles: "customer", deletedAt: null }).select("name email phone").lean()
      : [];
    const clients = [...matchedClients, ...moreClients].slice(0, RESULT_LIMIT);
    const extras = await clientLeadExtras(clients.map((client) => client._id));

    const clientResults = clients.map((client) => ({
      type: "client",
      _id: client._id,
      name: client.name || "",
      businessName: extras.get(String(client._id))?.businessName || "",
      email: client.email || "",
      phone: client.phone || "",
    }));

    const leadResults = leads.map((lead) => ({
      type: "lead",
      _id: lead._id,
      name: lead.name || "",
      businessName: lead.businessName || "",
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
