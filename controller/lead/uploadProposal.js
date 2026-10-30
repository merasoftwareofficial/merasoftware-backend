const path = require("path");
const leadModel = require("../../models/leadModel");
const GoogleDriveService = require("../../helpers/googleDriveService");
const { statusAfterFirstProposal } = require("../../helpers/leadStatuses");

// Path to the Google Drive credentials file (same resolution as submitUpdateRequest.js)
let KEY_FILE_PATH;
if (process.env.NODE_ENV === "production" && process.env.GOOGLE_DRIVE_CREDENTIALS_PATH) {
  KEY_FILE_PATH = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH;
} else {
  KEY_FILE_PATH = path.join(__dirname, "../../config/google-drive-credentials.json");
}
const FOLDER_NAME = "LeadProposals";

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

    lead.proposals.push({
      version: nextVersion,
      name: safeFilename,
      driveFileId: uploadedFile.id,
      downloadLink,
      type: file.mimetype,
      size: file.size,
      uploadedAt: new Date(),
      uploadedBy: req.userId,
    });

    // First proposal auto-advances the pipeline to "Proposal Sent".
    if (nextVersion === 1) {
      lead.status = statusAfterFirstProposal(lead.status);
    }

    await lead.save();

    return res.json({
      message: "Proposal uploaded successfully",
      data: { version: nextVersion },
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
