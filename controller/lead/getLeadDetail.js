const userModel = require("../../models/userModel");
const leadModel = require("../../models/leadModel");
const { FinalMessage, Queue } = require("../../whatsapp/src/models.js");
const { EmailDraft } = require("../../models/emailControlModel");
const { LABELS, MESSAGES, blockForLead } = require("../../helpers/leadContactBlock");
const { targetsForLead } = require("../../helpers/offerTargets");
const { State, STATE_ID } = require("../../whatsapp/src/models.js");
const { NEGATIVE } = require("../../helpers/leadStatuses");
const { currentStatus, stopOption } = require("../../helpers/finalMessageCycle");
const { startBlocker } = require("../../helpers/finalMessage");
const { workerAlive } = require("../../helpers/whatsappReadiness");

const getLeadDetailController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { leadId } = req.params;

    const lead = await leadModel
      .findOne({ _id: leadId, deletedAt: null })
      .populate("followUps.createdBy", "name email")
      .populate("referredByUserId", "name phone email")
      .lean();

    if (!lead) {
      return res.status(404).json({
        message: "Lead not found",
        error: true,
        success: false,
      });
    }

    const [finalMessage, blocked, offerTargets, clientAccount] = await Promise.all([
      FinalMessage.findOne({ leadId: lead._id }).select("status sentAt deadlineAt lastReplyAt lastReplyText replySeenAt decision subjectKind draftId hours stoppedAt stopReason stopSource expiryEnabled expiryQueuedAt originalMessage.id").lean(),
      blockForLead(lead),
      targetsForLead(lead._id),
      lead.convertedToUserId ? userModel.findOne({ _id: lead.convertedToUserId, deletedAt: null, isGuest: { $ne: true }, roles: "customer" }).select("name email phone").lean() : null,
    ]);
    // Present the latest delivery result without waiting for the minute job or changing tracking.
    if (finalMessage && ['review', 'queued'].includes(finalMessage.status)) {
      const [queued, draft] = await Promise.all([
        Queue.findOne({ emailDraftId: finalMessage.draftId }).select('status sentAt').lean(),
        EmailDraft.findById(finalMessage.draftId).select('status expiresAt delivery.channels delivery.emailStatus').lean(),
      ]);
      if (queued?.status === 'sent' && queued.sentAt) {
        finalMessage.status = 'waiting';
        finalMessage.sentAt = queued.sentAt;
        finalMessage.deadlineAt = new Date(queued.sentAt.getTime() + finalMessage.hours * 3600000);
      } else if (['pending', 'sending'].includes(queued?.status)) finalMessage.status = 'queued';
      else if (queued || !draft || draft.status === 'skipped' || draft.expiresAt <= new Date()) finalMessage.status = 'not-sent';
      else if (draft.delivery?.channels && !draft.delivery.channels.includes('whatsapp') && draft.delivery.emailStatus === 'sent') finalMessage.status = 'email-only';
    }
    // What the page may offer comes from here, so a button shows only while it can do its job.
    if (finalMessage) {
      finalMessage.stopLabel = await stopOption(finalMessage);
      if (finalMessage.status === 'waiting') {
        const state = await State.findById(STATE_ID).select('heartbeatAt connection').lean();
        finalMessage.listening = workerAlive(state, new Date()) && state.connection === 'connected';
      }
      delete finalMessage.originalMessage;
    }
    lead.finalMessage = finalMessage;
    lead.finalMessageCanStart = false;
    if (currentStatus(lead) === NEGATIVE && finalMessage?.status !== 'review') {
      // An undecided review whose draft has lapsed reads as not sent here before the minute job records it.
      const blocker = await startBlocker(lead);
      lead.finalMessageCanStart = !blocker || (blocker === 'in-review' && finalMessage?.status === 'not-sent');
    }
    lead.contactBlock = blocked ? { reason: blocked, label: LABELS[blocked], message: MESSAGES[blocked] } : null;
    lead.offerTargets = offerTargets;
    lead.clientAvailable = Boolean(clientAccount);
    // The client account holds the real name, phone and email (Edit Details starts from these, not the lead's copy).
    lead.client = clientAccount ? { name: clientAccount.name || "", email: clientAccount.email || "", phone: clientAccount.phone || "" } : null;
    lead.serverNow = new Date();
    if (lead.convertedToUserId && lead.clientBehaviour === 'Negative') lead.finalMessageReadiness = await require('../../helpers/clientFinalMessageReadiness').clientStartReadiness(lead);

    return res.json({
      message: "Lead fetched successfully",
      data: lead,
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error fetching lead detail:", error);
    return res.status(400).json({
      message: error.message || "Failed to fetch lead",
      error: true,
      success: false,
    });
  }
};

module.exports = getLeadDetailController;
