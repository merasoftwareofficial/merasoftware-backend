const leadModel = require("../../models/leadModel");
const transactionModel = require("../../models/transactionModel");
const { referredLeadStatus } = require("../../helpers/leadStatuses");

// Customer-facing: leads this user referred via the Add Lead "Reference" flow
// (leadModel.referredByUserId), each paired with the reward amount credited
// for it. The reward transaction's id is deterministic (LEADREF-<leadId>,
// see createLead.js) so it can be looked up directly instead of matching by
// description text.
const myReferredLeadsController = async (req, res) => {
  try {
    const leads = await leadModel
      .find({ referredByUserId: req.userId, deletedAt: null })
      .select("name status createdAt")
      .sort({ createdAt: -1 })
      .lean();

    if (leads.length === 0) {
      return res.json({
        message: "Referred leads fetched",
        data: [],
        success: true,
        error: false,
      });
    }

    const transactionIds = leads.map((lead) => `LEADREF-${lead._id}`);
    const rewardTransactions = await transactionModel
      .find({ transactionId: { $in: transactionIds } })
      .select("transactionId amount")
      .lean();

    const rewardByTransactionId = new Map(
      rewardTransactions.map((txn) => [txn.transactionId, txn.amount])
    );

    const data = leads.map((lead) => ({
      _id: lead._id,
      name: lead.name,
      status: referredLeadStatus(lead.status),
      createdAt: lead.createdAt,
      rewardAmount: rewardByTransactionId.get(`LEADREF-${lead._id}`) || 0,
    }));

    return res.json({
      message: "Referred leads fetched",
      data,
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error fetching referred leads:", error);
    return res.status(400).json({
      message: error.message || "Failed to fetch referred leads",
      error: true,
      success: false,
    });
  }
};

module.exports = myReferredLeadsController;
