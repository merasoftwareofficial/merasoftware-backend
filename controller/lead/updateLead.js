const path = require("path");
const leadModel = require("../../models/leadModel");
const GoogleDriveService = require("../../helpers/googleDriveService");
const { isAccountEmail } = require("../../helpers/emailValidator");
const { SELECTABLE_LEAD_STATUSES: ALLOWED_STATUSES } = require("../../helpers/leadStatuses");

// Path to the Google Drive credentials file (same resolution as uploadProposal.js).
let KEY_FILE_PATH;
if (process.env.NODE_ENV === "production" && process.env.GOOGLE_DRIVE_CREDENTIALS_PATH) {
  KEY_FILE_PATH = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH;
} else {
  KEY_FILE_PATH = path.join(__dirname, "../../config/google-drive-credentials.json");
}
const FOLLOWUP_FOLDER_NAME = "LeadFollowUpFiles";

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

    // Converted leads are historical; block further edits (Phase 4 owns convert).
    if (lead.convertedToUserId) {
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
      // No badge sent = keep the current status. A status set automatically can stay, not be chosen.
      const badge = (req.body.badge || "").trim() || lead.status;
      if (badge !== lead.status && !ALLOWED_STATUSES.includes(badge)) {
        return res.status(400).json({
          message: "Please select a valid stage badge",
          error: true,
          success: false,
        });
      }

      const note = (req.body.note || "").trim();
      if (!note) {
        return res.status(400).json({
          message: "Please provide a follow-up note",
          error: true,
          success: false,
        });
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

      lead.followUps.push({
        note,
        badge,
        attachment,
        date: new Date(),
        createdBy: req.userId,
        createdAt: new Date(),
      });

      // Merge: the lead's current pipeline stage follows the latest follow-up badge.
      lead.status = badge;

      const savedLead = await lead.save();

      return res.json({
        message: "Follow-up added",
        data: savedLead,
        success: true,
        error: false,
      });
    }

    // Edit an existing follow-up's badge/note in place. Editing the badge on the
    // MOST RECENT follow-up also updates the lead's current status, since the
    // lead's status always mirrors the latest follow-up's badge (same rule as add).
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

      // An old badge that can no longer be chosen (Proposal Sent, Won) may stay when only the note changes.
      const badge = (req.body.badge || "").trim();
      if (badge !== followUp.badge && !ALLOWED_STATUSES.includes(badge)) {
        return res.status(400).json({
          message: "Please select a valid stage badge",
          error: true,
          success: false,
        });
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

      const latestFollowUp = [...lead.followUps].sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
      )[0];
      if (latestFollowUp && String(latestFollowUp._id) === String(followUp._id)) {
        lead.status = badge;
      }

      const savedLead = await lead.save();

      return res.json({
        message: "Follow-up updated",
        data: savedLead,
        success: true,
        error: false,
      });
    }

    // Edit the lead's own contact details. Same rules as createLead.js: name and
    // phone are required, email is optional and stored lowercase, and no other
    // lead may already hold the same phone or email. Source and notes change
    // only when sent, so a form that edits just the contact fields keeps them.
    if (action === "editDetails") {
      const cleanName = (req.body.name || "").trim();
      const cleanPhone = (req.body.phone || "").trim();
      const cleanEmail = (req.body.email || "").trim().toLowerCase();
      const hasSource = req.body.source !== undefined;
      const cleanSource = hasSource ? String(req.body.source).trim() : lead.source;

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

      const existingLead = await leadModel
        .findOne({ _id: { $ne: lead._id }, $or: duplicateOr })
        .lean();
      if (existingLead) {
        return res.status(409).json({
          message: "A lead with this phone or email already exists",
          error: true,
          success: false,
        });
      }

      lead.name = cleanName;
      lead.phone = cleanPhone;
      lead.email = cleanEmail;
      lead.source = cleanSource;
      if (req.body.notes !== undefined) {
        lead.notes = req.body.notes;
      }

      const savedLead = await lead.save();

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
