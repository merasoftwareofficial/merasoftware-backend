const path = require("path");
const mongoose = require("mongoose");
const leadModel = require("../../models/leadModel");
const userModel = require("../../models/userModel");
const GoogleDriveService = require("../../helpers/googleDriveService");
const { isAccountEmail } = require("../../helpers/emailValidator");
const offerTargetModel = require("../../models/offerTargetModel");
const { CONTACTED, INQUIRY, NEGATIVE, WON, WRONG, NAME_OPTIONAL_STATUSES, SELECTABLE_LEAD_STATUSES: ALLOWED_STATUSES, SELECTABLE_OFFER_STAGES, CLIENT_BEHAVIOURS, DEFAULT_CLIENT_BEHAVIOUR } = require("../../helpers/leadStatuses");
const { changeClientStatus } = require("../../helpers/clientStatus");
const { reconcileCycle } = require("../../helpers/finalMessageCycle");
const { clientStartReadiness } = require("../../helpers/clientFinalMessageReadiness");
const { isClient } = require("../../helpers/wonLead");
const { prepareFor: prepareFinalMessage } = require("../../helpers/finalMessage");
const { findAccountsByPhone, findLeadsByPhone, phoneKey } = require("../../helpers/leadPhone");
const { hasConfirmedName } = require("../../helpers/leadName");
const { memberOnPhone } = require("../../helpers/personLead");

// Path to the Google Drive credentials file (same resolution as uploadProposal.js).
let KEY_FILE_PATH;
if (process.env.NODE_ENV === "production" && process.env.GOOGLE_DRIVE_CREDENTIALS_PATH) {
  KEY_FILE_PATH = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH;
} else {
  KEY_FILE_PATH = path.join(__dirname, "../../config/google-drive-credentials.json");
}
const FOLLOWUP_FOLDER_NAME = "LeadFollowUpFiles";

const NEEDS_NAME = { message: "Add this lead's name first: use Edit Lead.", error: true, success: false };
const missingNameFor = (lead, status) => !hasConfirmedName(lead) && !NAME_OPTIONAL_STATUSES.includes(status);
// A lead just marked Negative: the popup asks whether its final message goes. The stage is saved whatever happens here.
const offerFinalMessage = async (lead, previousStatus) => {
  if (lead.status !== NEGATIVE || previousStatus === NEGATIVE) return undefined;
  try { return await prepareFinalMessage(lead); }
  catch (error) { console.error("Lead saved; its final message is unavailable:", error.message); return "unavailable"; }
};

// Every outcome other than an opened popup is told to the admin in words.
const noteFor = (outcome) => (outcome && outcome !== "prepared" ? require("./finalMessage").WHY_NOT[outcome] || "" : "");
const failed = (res, error) => res.status(error.status || 400).json({ message: error.message, finalMessageReadiness: error.finalMessageReadiness, error: true, success: false });

const NOT_FOR_CLIENT = { message: "A client can't be marked Wrong.", error: true, success: false };
// A client's own request lead, or a number a client holds: this person has already been filtered in.
const isClientPerson = async (lead) => Boolean(lead.requestedByUserId) || (await findAccountsByPhone(lead.phone)).some(isClient);

const updateLeadController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { leadId } = req.params;
    const { action } = req.body;

    const lead = await leadModel.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        message: "Lead not found",
        error: true,
        success: false,
      });
    }

    // Conversion locks account details, but follow-up notes remain available.
    const isMatured = Boolean(lead.convertedToUserId) || lead.status === WON;
    const previousStatus = lead.status;
    if (action === "setBehaviour") {
      try {
        const data = await changeClientStatus(leadId, req.body.behaviour, req.userId);
        return res.json({ message: "Current status updated", data, finalMessage: data.finalMessage, finalMessageNote: noteFor(data.finalMessage), success: true, error: false });
      } catch (error) { return failed(res, error); }
    }

    // A client's lead keeps its follow-ups and its contact details editable (editDetails keeps the account in step).
    if (lead.convertedToUserId && !["followUp", "editFollowUp", "editDetails"].includes(action)) {
      return res.status(409).json({
        message: "This lead is already converted to a client and cannot be edited",
        error: true,
        success: false,
      });
    }

    // Unified follow-up: one entry carries a pipeline-stage badge, a mandatory
    // remark, and an optional file. Adding the follow-up also moves the lead's
    // own status to the chosen badge (the two are merged into one action).
    if (action === "followUp") {
      // The form always sends a status. The current one is accepted even if it can't be chosen (Won).
      const badge = (req.body.badge || "").trim();
      // A line for an offer moves only that offer's stage: the lead's own stage, and any lead rules, stay out of it.
      const offerSlug = (req.body.offerSlug || "").trim();
      const target = offerSlug ? await offerTargetModel.findOne({ leadId: lead._id, offerSlug }) : null;
      if (offerSlug && !target) {
        return res.status(404).json({ message: "This person is not in that offer", error: true, success: false });
      }
      // A client's line carries their current status, chosen the way a lead's stage is (helpers/clientStatus.js).
      const clientFollowUp = Boolean(lead.convertedToUserId) && !target;
      const clientBefore = lead.clientBehaviour || DEFAULT_CLIENT_BEHAVIOUR;
      if (target) {
        const allowed = target.stage === WON ? badge === WON : SELECTABLE_OFFER_STAGES.includes(badge);
        if (!allowed) return res.status(400).json({ message: "Please select a valid stage for this offer", error: true, success: false });
      } else if (clientFollowUp) {
        // Won comes from a page opened before this form showed the status: a note that keeps the status.
        // So does the current one, which may be Inquiry: only the system sets that, but a note may keep it.
        if (badge !== WON && badge !== clientBefore && !CLIENT_BEHAVIOURS.includes(badge)) return res.status(400).json({ message: "Please select a valid status", error: true, success: false });
      } else {
        if (isMatured && badge !== WON) {
          return res.status(400).json({ message: "Matured stage cannot be changed", error: true, success: false });
        }
        if (!isMatured && badge !== lead.status && !ALLOWED_STATUSES.includes(badge)) {
          return res.status(400).json({
            message: "Please select a valid stage badge",
            error: true,
            success: false,
          });
        }
        if (missingNameFor(lead, badge)) return res.status(400).json(NEEDS_NAME);
        if (badge === WRONG && await isClientPerson(lead)) return res.status(400).json(NOT_FOR_CLIENT);
      }

      const note = (req.body.note || "").trim();
      if (!note) {
        return res.status(400).json({
          message: "Please provide a follow-up note",
          error: true,
          success: false,
        });
      }

      // Checked before the file uploads: a client entering Negative must be able to get the final message.
      if (clientFollowUp && badge === NEGATIVE && clientBefore !== NEGATIVE) {
        const readiness = await clientStartReadiness({ ...lead.toObject(), clientBehaviour: NEGATIVE });
        if (!readiness.ready) return res.status(409).json({ message: readiness.message, finalMessageReadiness: readiness, error: true, success: false });
      }

      // Optional attachment: upload to Google Drive only when a file is present.
      let attachment = null;
      const file = (req.files && req.files[0]) || null;
      if (file) {
        const driveService = new GoogleDriveService(KEY_FILE_PATH, FOLLOWUP_FOLDER_NAME);
        const folderId = await driveService.createFolder();

        const fileBuffer = Buffer.from(file.buffer);
        const safeFilename = file.originalname.replace(/\s+/g, "_");

        const uploadedFile = await driveService.uploadFile(
          safeFilename,
          fileBuffer,
          file.mimetype,
          folderId
        );

        attachment = {
          name: safeFilename,
          driveFileId: uploadedFile.id,
          downloadLink: driveService.getDownloadLink(uploadedFile.id),
          type: file.mimetype,
          size: file.size,
        };
      }

      if (clientFollowUp && badge !== WON && badge !== clientBefore) {
        try {
          const result = await changeClientStatus(lead._id, badge, req.userId, { note, attachment });
          return res.json({ message: "Follow-up added", data: await leadModel.findById(lead._id), finalMessage: result.finalMessage, finalMessageNote: noteFor(result.finalMessage), success: true, error: false });
        } catch (error) { return failed(res, error); }
      }

      lead.followUps.push({
        note,
        badge,
        attachment,
        date: new Date(),
        createdBy: req.userId,
        createdAt: new Date(),
        ...(target ? { offerSlug } : {}),
      });

      // Merge: the lead's current pipeline stage follows the latest follow-up badge.
      if (target) target.stage = badge;
      else if (!clientFollowUp) lead.status = badge;

      const savedLead = await lead.save();
      if (target) await target.save();
      // Leaving Negative ends a running final message now, with its reason on the timeline.
      else await reconcileCycle(lead._id, { actor: req.userId });
      const finalMessage = target || clientFollowUp ? undefined : await offerFinalMessage(savedLead, previousStatus);

      return res.json({
        message: "Follow-up added",
        data: savedLead,
        finalMessage,
        finalMessageNote: noteFor(finalMessage),
        success: true,
        error: false,
      });
    }

    // Edit an existing follow-up's badge/note in place. Changing the badge on the
    // MOST RECENT follow-up also updates the lead's current status (same rule as add);
    // editing only the note never touches the status.
    if (action === "editFollowUp") {
      const { followUpId } = req.body;
      const followUp = lead.followUps.id(followUpId);
      if (!followUp) {
        return res.status(404).json({
          message: "Follow-up not found",
          error: true,
          success: false,
        });
      }

      if (followUp.messageDraftId) {
        return res.status(400).json({ message: "This line records a sent message and cannot be edited", error: true, success: false });
      }

      // An old badge that can no longer be chosen (Proposal Sent, Won) may stay when only the note changes.
      const badge = (req.body.badge || "").trim();
      const badgeChanged = badge !== followUp.badge;
      const target = followUp.offerSlug ? await offerTargetModel.findOne({ leadId: lead._id, offerSlug: followUp.offerSlug }) : null;
      if (followUp.offerSlug) {
        if (badgeChanged && (!target || target.stage === WON || !SELECTABLE_OFFER_STAGES.includes(badge))) {
          return res.status(400).json({ message: "Please select a valid stage for this offer", error: true, success: false });
        }
      } else {
        if (isMatured && badgeChanged) {
          return res.status(400).json({ message: "Historical stage cannot be changed for a matured lead", error: true, success: false });
        }
        if (badgeChanged && !ALLOWED_STATUSES.includes(badge)) {
          return res.status(400).json({
            message: "Please select a valid stage badge",
            error: true,
            success: false,
          });
        }
        if (badgeChanged && missingNameFor(lead, badge)) return res.status(400).json(NEEDS_NAME);
        if (badgeChanged && badge === WRONG && await isClientPerson(lead)) return res.status(400).json(NOT_FOR_CLIENT);
      }

      const note = (req.body.note || "").trim();
      if (!note) {
        return res.status(400).json({
          message: "Please provide a follow-up note",
          error: true,
          success: false,
        });
      }

      followUp.badge = badge;
      followUp.note = note;

      // The latest line of the same kind decides: the offer's stage for an offer's line, the lead's for the rest.
      const latestFollowUp = lead.followUps.filter((item) => !item.messageDraftId && (item.offerSlug || "") === (followUp.offerSlug || "")).sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
      )[0];
      const isLatest = badgeChanged && latestFollowUp && String(latestFollowUp._id) === String(followUp._id);
      if (target && isLatest) target.stage = badge;
      else if (!followUp.offerSlug && !isMatured && isLatest) lead.status = badge;

      const savedLead = await lead.save();
      if (target && isLatest) await target.save();
      if (!followUp.offerSlug) await reconcileCycle(lead._id, { actor: req.userId });
      const finalMessage = followUp.offerSlug ? undefined : await offerFinalMessage(savedLead, previousStatus);

      return res.json({
        message: "Follow-up updated",
        data: savedLead,
        finalMessage,
        finalMessageNote: noteFor(finalMessage),
        success: true,
        error: false,
      });
    }

    // Edit the lead's own contact details. Same rules as createLead.js: name and
    // phone are required, email is optional and stored lowercase, and no other
    // lead may already hold the same phone or email. Source, notes, business name
    // and alternate number change only when sent, so a form that edits just the
    // contact fields keeps them.
    // A client's (converted) lead can be edited too: its email is the login email and
    // stays as it is, and a new name or phone is written to the client account as well.
    if (action === "editDetails") {
      const clientId = lead.convertedToUserId;
      // The account is the source of truth for a client's name, phone and email; the lead holds a copy.
      // A trashed or missing account leaves only the lead to edit.
      const account = clientId ? await userModel.findOne({ _id: clientId, deletedAt: null }).select("name email phone").lean() : null;
      const cleanName = (req.body.name || "").trim();
      const cleanPhone = (req.body.phone || "").trim();
      const cleanEmail = (req.body.email || "").trim().toLowerCase();
      const hasSource = req.body.source !== undefined;
      const cleanSource = hasSource ? String(req.body.source).trim() : lead.source;
      const cleanBusinessName = req.body.businessName !== undefined ? String(req.body.businessName).trim() : lead.businessName;
      const cleanAltPhone = req.body.altPhone !== undefined ? String(req.body.altPhone).trim() : lead.altPhone;

      if (!cleanName) {
        return res.status(400).json({
          message: "Please provide lead name",
          error: true,
          success: false,
        });
      }

      if (!cleanPhone) {
        return res.status(400).json({
          message: "Please provide a phone number",
          error: true,
          success: false,
        });
      }

      if (cleanEmail && !isAccountEmail(cleanEmail)) {
        return res.status(400).json({
          message: "Please provide a valid email address",
          error: true,
          success: false,
        });
      }

      const lockedEmail = account ? String(account.email || "").toLowerCase() : (lead.email || "");
      if (clientId && cleanEmail !== lockedEmail) {
        return res.status(400).json({
          message: "A client's email is their login email and cannot be changed here",
          error: true,
          success: false,
        });
      }

      if (cleanAltPhone && phoneKey(cleanAltPhone) === phoneKey(cleanPhone)) {
        return res.status(400).json({
          message: "The alternate number is the same as the phone number",
          error: true,
          success: false,
        });
      }

      // "Reference" is set only at creation: createLead.js links the referrer
      // and credits their wallet reward then. Changing it here would leave the
      // reward and referredByUserId out of step with the source.
      const isReferenceLead = lead.source === "Reference" || Boolean(lead.referredByUserId);
      if (isReferenceLead && cleanSource !== lead.source) {
        return res.status(400).json({
          message: "The source of a Reference lead cannot be changed",
          error: true,
          success: false,
        });
      }
      if (!isReferenceLead && cleanSource === "Reference") {
        return res.status(400).json({
          message: "Reference can only be chosen when the lead is created",
          error: true,
          success: false,
        });
      }

      const duplicateOr = [{ phone: cleanPhone }];
      if (cleanEmail) duplicateOr.push({ email: cleanEmail });

      // A client's own project requests (customerProjectRequest.js) carry the client's phone and
      // email: they are the same person, not a duplicate.
      const others = { _id: { $ne: lead._id }, ...(clientId ? { requestedByUserId: { $ne: clientId } } : {}) };
      const existingLead = await leadModel
        .findOne({ ...others, $or: duplicateOr })
        .lean();
      if (existingLead || (await findLeadsByPhone(cleanPhone, others)).length) {
        return res.status(409).json({
          message: "A lead with this phone or email already exists",
          error: true,
          success: false,
        });
      }

      // The client account holds the same phone: no other account may already use the new one.
      // Compared with the account's number, which may differ from the lead's older copy.
      const phoneChanged = phoneKey(cleanPhone) !== phoneKey(account ? account.phone : lead.phone);
      if (clientId && phoneChanged) {
        const otherAccounts = (await findAccountsByPhone(cleanPhone)).filter((user) => String(user._id) !== String(clientId) && !user.deletedAt);
        if (otherAccounts.length) {
          return res.status(409).json({
            message: "Another account already uses this phone number",
            error: true,
            success: false,
          });
        }
      }

      // One main phone = one person: a new number that is a website member's makes this their lead (never another's).
      if (!clientId && !lead.reservationUserId && phoneChanged) {
        const { member, conflict } = await memberOnPhone(cleanPhone, { exceptLeadId: lead._id });
        if (conflict) return res.status(409).json({ message: conflict, error: true, success: false });
        if (member) lead.reservationUserId = member._id;
      }

      // Owner rule: an Inquiry becomes a real lead the moment it gets a name.
      // Saving here is the admin confirming the name, so a WhatsApp guess becomes the real name.
      if (lead.status === INQUIRY) lead.status = CONTACTED;
      lead.name = cleanName;
      lead.nameFromWhatsapp = false;
      lead.businessName = cleanBusinessName;
      lead.phone = cleanPhone;
      lead.altPhone = cleanAltPhone;
      lead.email = cleanEmail;
      lead.source = cleanSource;
      if (req.body.notes !== undefined) {
        lead.notes = req.body.notes;
      }

      // Account and lead change together or not at all.
      let savedLead;
      if (account) {
        await mongoose.connection.transaction(async (session) => {
          await userModel.updateOne({ _id: account._id }, { $set: { name: cleanName, phone: cleanPhone } }, { session });
          savedLead = await lead.save({ session });
        });
      } else {
        savedLead = await lead.save();
      }
      // A new phone number ends a final message that went to the old one.
      await reconcileCycle(lead._id, { actor: req.userId });

      return res.json({
        message: "Lead details updated",
        data: savedLead,
        success: true,
        error: false,
      });
    }

    return res.status(400).json({
      message: "Invalid action",
      error: true,
      success: false,
    });
  } catch (error) {
    console.error("Error updating lead:", error);
    return res.status(400).json({
      message: error.message || "Failed to update lead",
      error: true,
      success: false,
    });
  }
};

module.exports = updateLeadController;
