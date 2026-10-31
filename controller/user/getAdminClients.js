const userModel = require("../../models/userModel");
const orderModel = require("../../models/orderProductModel");
const updateRequestModel = require("../../models/updateRequestModel");
const transactionModel = require("../../models/transactionModel");
const monthlyInvoiceModel = require("../../models/monthlyInvoiceModel");
const ticketModel = require("../../models/ticketModel");
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

const addRecordActivity = (activityByClient, userId, candidates) => {
  if (!userId) return;

  const clientId = userId.toString();
  const current = activityByClient.get(clientId) || {
    timestamp: 0,
    value: null,
    source: "client_created",
  };
  const latest = latestCandidate(candidates);

  if (latest.timestamp > current.timestamp) {
    activityByClient.set(clientId, latest);
  }
};

const getOrderActivity = (order) => [
  { value: order.createdAt, source: "purchase" },
  { value: order.updatedAt, source: "project_updated" },
  { value: order.lastUpdated, source: "project_updated" },
  ...(order.checkpoints || []).map((checkpoint) => ({
    value: checkpoint.completedAt,
    source: "checkpoint_completed",
  })),
  ...(order.messages || []).map((message) => ({
    value: message.timestamp,
    source: "project_message",
  })),
  ...(order.projectNodeEvents || []).map((event) => ({
    value: event.occurredAt,
    source: "project_node_updated",
  })),
  ...(order.monthlyRenewalHistory || []).map((renewal) => ({
    value: renewal.renewalDate,
    source: "plan_renewed",
  })),
];

const getUpdateRequestActivity = (request) => [
  { value: request.createdAt, source: "update_request" },
  { value: request.updatedAt, source: "update_request_updated" },
  { value: request.completedAt, source: "update_completed" },
  ...(request.instructions || []).map((item) => ({
    value: item.timestamp,
    source: "update_request",
  })),
  ...(request.developerNotes || []).map((item) => ({
    value: item.timestamp,
    source: "developer_note",
  })),
  ...(request.developerMessages || []).map((item) => ({
    value: item.timestamp,
    source: "developer_message",
  })),
];

const getTransactionActivity = (transaction) => {
  const eventDate = transaction.paymentStatus === "approved" || transaction.status === "completed"
    ? transaction.verificationDate || transaction.updatedAt || transaction.createdAt
    : transaction.paymentStatus === "rejected" || transaction.status === "rejected"
      ? transaction.rejectedAt || transaction.verificationDate || transaction.updatedAt || transaction.createdAt
      : transaction.createdAt || transaction.date || transaction.updatedAt;

  return [{ value: eventDate, source: "payment_updated" }];
};

const getInvoiceActivity = (invoice) => [{
  value: invoice.status === "paid" ? invoice.paidDate || invoice.updatedAt : invoice.updatedAt || invoice.createdAt,
  source: invoice.status === "paid" ? "invoice_paid" : "invoice_updated",
}];

const getTicketActivity = (ticket) => [
  { value: ticket.createdAt, source: "ticket_created" },
  { value: ticket.updatedAt, source: "ticket_updated" },
  ...(ticket.messages || []).map((message) => ({
    value: message.timestamp,
    source: "ticket_message",
  })),
  ...(ticket.statusHistory || []).map((item) => ({
    value: item.timestamp,
    source: "ticket_status_updated",
  })),
];

async function getAdminClients(req, res) {
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
    await purgeExpiredGuests();

    const clients = await userModel
      .find({ roles: "customer", deletedAt: null, isGuest: { $ne: true } })
      .select("name email phone status createdAt updatedAt")
      .lean();

    const clientIds = clients.map((client) => client._id);
    const [orders, updateRequests, transactions, invoices, tickets] = await Promise.all([
      orderModel
        .find({ userId: { $in: clientIds } })
        .select("userId createdAt updatedAt lastUpdated checkpoints.completedAt messages.timestamp projectNodeEvents.occurredAt monthlyRenewalHistory.renewalDate")
        .lean(),
      updateRequestModel
        .find({ userId: { $in: clientIds } })
        .select("userId createdAt updatedAt completedAt instructions.timestamp developerNotes.timestamp developerMessages.timestamp")
        .lean(),
      transactionModel
        .find({ userId: { $in: clientIds } })
        .select("userId createdAt updatedAt date paymentStatus status verificationDate rejectedAt")
        .lean(),
      monthlyInvoiceModel
        .find({ userId: { $in: clientIds } })
        .select("userId createdAt updatedAt paidDate status")
        .lean(),
      ticketModel
        .find({ userId: { $in: clientIds } })
        .select("userId createdAt updatedAt messages.timestamp statusHistory.timestamp")
        .lean(),
    ]);

    const activityByClient = new Map();
    orders.forEach((order) => addRecordActivity(activityByClient, order.userId, getOrderActivity(order)));
    updateRequests.forEach((request) => addRecordActivity(activityByClient, request.userId, getUpdateRequestActivity(request)));
    transactions.forEach((transaction) => addRecordActivity(activityByClient, transaction.userId, getTransactionActivity(transaction)));
    invoices.forEach((invoice) => addRecordActivity(activityByClient, invoice.userId, getInvoiceActivity(invoice)));
    tickets.forEach((ticket) => addRecordActivity(activityByClient, ticket.userId, getTicketActivity(ticket)));

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

    res.json({
      message: "Clients fetched successfully",
      data: enrichedClients,
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

module.exports = getAdminClients;
