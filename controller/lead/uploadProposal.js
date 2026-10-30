const path = require("path");
const leadModel = require("../../models/leadModel");
const GoogleDriveService = require("../../helpers/googleDriveService");
const { prepareTemplatedMail } = require("../../helpers/emailService");
const { EVENT: PROPOSAL_MESSAGE, hasEmail, whatsappPreview } = require("../../helpers/leadProposalMessage");

// Path to the Google Drive credentials file (same resolution as submitUpdateRequest.js)
let KEY_FILE_PATH;
if (process.env.NODE_ENV === "production" && process.env.GOOGLE_DRIVE_CREDENTIALS_PATH) {
  KEY_FILE_PATH = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH;
} else {
  KEY_FILE_PATH = path.join(__dirname, "../../config/google-drive-credentials.json");
}
const FOLDER_NAME = "LeadProposals";

/** "25000" → 25000; empty → null; anything else → undefined. */
const parseAmount = (raw) => {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
};

const uploadProposalController = async (req, res) => {
  try {
    if (req.userRole !== "admin") {
      return res.status(403).json({
        message: "Forbidden",
        error: true,
        success: false,
      });
    }

    const { leadId } = req.params;

    const lead = await leadModel.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        message: "Lead not found",
        error: true,
        success: false,
      });
    }

    if (lead.convertedToUserId) {
      return res.status(409).json({
        message: "This lead is already converted to a client and cannot be edited",
        error: true,
        success: false,
      });
    }

    const file = (req.files && req.files[0]) || null;
    if (!file) {
      return res.status(400).json({
        message: "Please attach a proposal file (PDF or DOC)",
        error: true,
        success: false,
      });
    }

    const amount = parseAmount(req.body.amount);
    if (amount === undefined) {
      return res.status(400).json({
        message: "Please enter a valid amount",
        error: true,
        success: false,
      });
    }
    const note = String(req.body.note || "").trim();

    // Upload to Google Drive (reuse the existing shared service).
    const driveService = new GoogleDriveService(KEY_FILE_PATH, FOLDER_NAME);
    const folderId = await driveService.createFolder();

    const fileBuffer = Buffer.from(file.buffer);
    const safeFilename = file.originalname.replace(/\s+/g, "_");

    const uploadedFile = await driveService.uploadFile(
      safeFilename,
      fileBuffer,
      file.mimetype,
      folderId
    );

    const downloadLink = driveService.getDownloadLink(uploadedFile.id);

    // New version = current highest version + 1 (timeline of revisions).
    const nextVersion = (lead.proposals || []).reduce((max, item) => Math.max(max, item.version || 0), 0) + 1;

    const proposal = {
      version: nextVersion,
      name: safeFilename,
      driveFileId: uploadedFile.id,
      downloadLink,
      type: file.mimetype,
      size: file.size,
      uploadedAt: new Date(),
      uploadedBy: req.userId,
      amount,
      note,
    };
    lead.proposals.push(proposal);

    // The first proposal sets the permanent Proposal Sent badge. The status stays the admin's choice.
    if (!lead.proposalSentAt) lead.proposalSentAt = proposal.uploadedAt;
    const amountText = amount === null ? "" : `, ₹${amount.toLocaleString("en-IN")}`;
    lead.followUps.push({
      note: `Proposal v${nextVersion} added${amountText}${note ? `. ${note}` : ""}`,
      badge: lead.status,
      date: new Date(),
      createdBy: req.userId,
      createdAt: new Date(),
    });

    await lead.save();

    // The proposal is saved whatever happens to its message. Nothing is sent before the admin's review.
    let whatsapp = null;
    let messageUnavailable = false;
    try {
      if (hasEmail(lead)) {
        await prepareTemplatedMail(PROPOSAL_MESSAGE, lead, proposal);
      } else {
        whatsapp = await whatsappPreview(lead, proposal);
      }
    } catch (messageError) {
      console.error("Proposal saved; its message is unavailable:", messageError.message);
      messageUnavailable = true;
    }

    return res.json({
      message: "Proposal added",
      data: { version: nextVersion, whatsappPreview: whatsapp, messageUnavailable },
      success: true,
      error: false,
    });
  } catch (error) {
    console.error("Error uploading proposal:", error);
    return res.status(400).json({
      message: error.message || "Failed to upload proposal",
      error: true,
      success: false,
    });
  }
};

module.exports = uploadProposalController;
