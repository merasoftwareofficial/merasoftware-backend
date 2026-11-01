const userModel = require("../../models/userModel");
const readClientActivity = require('../../helpers/clientActivity');
const purgeExpiredGuests = require("../../helpers/purgeExpiredGuests");

const toTimestamp = (value) => {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const latestCandidate = (candidates) => {
  return candidates.reduce(
    (latest, candidate) => {
      const timestamp = toTimestamp(candidate.value);
      return timestamp > latest.timestamp
        ? { timestamp, value: candidate.value, source: candidate.source }
        : latest;
    },
    { timestamp: 0, value: null, source: "client_created" }
  );
};

async function getAdminClients(req, res, dashboard = false) {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    // Lazy purge, same pattern as controller/trash/getTrash.js: opening this
    // list is what opportunistically cleans up expired guest accounts.
    if (!dashboard) await purgeExpiredGuests();

    const clients = await userModel
      .find({ roles: "customer", deletedAt: null, isGuest: { $ne: true } })
      .select("name email phone status createdAt updatedAt")
      .lean();

    const clientIds = clients.map((client) => client._id);
    const activityByClient = await readClientActivity(clientIds);

    const enrichedClients = clients.map((client) => {
      const activity = latestCandidate([
        { value: client.createdAt, source: "client_created" },
        { value: client.updatedAt, source: "client_updated" },
        ...(activityByClient.has(client._id.toString()) ? [activityByClient.get(client._id.toString())] : []),
      ]);
      return {
        ...client,
        latestActivityAt: activity?.value || client.createdAt,
        latestActivitySource: activity?.source || "client_created",
      };
    });

    let data = enrichedClients;
    if (dashboard) {
      const start = new Date(req.query.monthStart);
      const end = new Date(req.query.monthEnd);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end - start > 32 * 86400000) {
        return res.status(400).json({ success: false, message: 'Valid month boundaries required' });
      }
      const active = enrichedClients.filter(client => (client.status || 'active').toLowerCase() === 'active').length;
      data = {
        total: enrichedClients.length, active, inactive: enrichedClients.length - active,
        joinedThisMonth: enrichedClients.filter(client => client.createdAt && new Date(client.createdAt) >= start && new Date(client.createdAt) < end).length,
        recentClients: [...enrichedClients].sort((a, b) => new Date(b.latestActivityAt || b.createdAt || 0) - new Date(a.latestActivityAt || a.createdAt || 0)).slice(0, 6),
      };
    }
    res.json({
      message: "Clients fetched successfully",
      data,
      success: true,
      error: false,
    });
  } catch (err) {
    res.status(400).json({
      message: err.message || err,
      error: true,
      success: false,
    });
  }
}

module.exports = (req, res) => getAdminClients(req, res);
module.exports.dashboard = (req, res) => getAdminClients(req, res, true);
