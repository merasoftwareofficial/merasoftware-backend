const updateRequestModel = require("../../models/updateRequestModel");
const orderModel = require("../../models/orderProductModel");
const AdminSettings = require("../../models/adminSettingsModel");
const GoogleDriveService = require("../../helpers/googleDriveService");
const { sendUpdateRequestNotification, sendUserConfirmation } = require("../../helpers/emailService");
const { createUpdateRequestNotification } = require("../../helpers/notificationService");
const userModel = require('../../models/userModel');
const mongoose = require('mongoose');
const path = require('path');
const { ObjectId } = mongoose.Types;
const { measureUpload } = require('../../helpers/uploadTiming');
const { uploadBatch } = require('../../helpers/uploadConcurrency');
const submission = require('../../helpers/uploadSubmission');

// Path to the Google Drive credentials file
let KEY_FILE_PATH;

// Check if running in production (Render)
if (process.env.NODE_ENV === 'production' && process.env.GOOGLE_DRIVE_CREDENTIALS_PATH) {
  // Use the path from environment variable
  KEY_FILE_PATH = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH;
} else {
  // Use local development path
  KEY_FILE_PATH = path.join(__dirname, '../../config/google-drive-credentials.json');
}
const FOLDER_NAME = 'ClientUpdateFiles';

// Error handling wrapper
const asyncHandler = (fn) => (req, res, next) => {
  return Promise.resolve(fn(req, res, next)).catch(err => {
    req.uploadNeedsReview ||= Boolean(err.uploadCleanupFailed);
    req.uploadCommitUncertain ||= Boolean(err.uploadCommitUncertain);
    console.error('Error in async handler:', err);
    return res.status(err.status || 500).json({
      message: err.message || 'Internal server error',
      error: true,
      success: false
    });
  });
};

const submitCore = asyncHandler(async (req, res) => {
  const timing = req.uploadTiming;
  timing?.mark('controller_entered'); // Auth/access checks and multipart parsing are complete.
  console.log("Request body keys:", Object.keys(req.body));
  console.log("Files received:", req.files ? req.files.length : 'No files');
  
  const userId = req.userId;
  if (!userId) {
    return res.status(400).json({
      message: "User ID is required",
      error: true,
      success: false
    });
  }
  
  const { planId } = req.body;
  if (!planId) {
    return res.status(400).json({
      message: "Plan ID is required",
      error: true,
      success: false
    });
  }
  
  let instructions = [];
  
  // Parse instructions if provided
  if (req.body.instructions) {
    try {
      instructions = JSON.parse(req.body.instructions);
      if (!Array.isArray(instructions)) throw new Error('Instructions must be an array');
      instructions = instructions
        .filter((item) => item && typeof item.text === 'string' && item.text.trim())
        .map((item) => ({ ...item, text: item.text.trim() }));
      console.log("Parsed instructions count:", instructions.length);
    } catch (e) {
      console.error('Error parsing instructions:', e);
      return res.status(400).json({
        message: "Invalid instructions format",
        error: true,
        success: false
      });
    }
  }

  if ((req.files || []).length === 0 && instructions.length === 0) {
    return res.status(400).json({ message: 'Add at least one file or instruction', error: true, success: false });
  }
  
  // Validate the update plan exists and belongs to the user
  const updatePlan = await measureUpload(timing, 'order_lookup', () => orderModel.findOne({
    _id: planId,
    userId
  }).populate('productId'));

  if (!updatePlan) {
    return res.status(404).json({
      message: 'Update plan not found',
      error: true,
      success: false
    });
  }
  if (updatePlan.paymentPolicy && !req.uploadAttempt) {
    return res.status(400).json({ success: false, error: true, message: 'An upload identifier is required for this offer. Refresh the upload form and retry.' });
  }
  const { isServiceUpload, isProjectUpload, isLegacyUpload } = await require('../../helpers/uploadOrderPolicy').assertUploadOrder(updatePlan, {
    fileCount: (req.files || []).length, serviceOrderId: req.body.serviceOrderId,
  });

  // Initialize Google Drive service
  timing?.mark('validation_complete');
  const driveService = new GoogleDriveService(KEY_FILE_PATH, FOLDER_NAME, timing);
  
  // Get file expiration days from admin settings
  const adminSettings = await measureUpload(timing, 'admin_settings', () => AdminSettings.getSettings());
  const fileExpirationDays = adminSettings.fileExpirationDays;
  
  // Process uploaded files and upload to Google Drive
  let fileObjects = [];
  if (req.files && req.files.length > 0) {
    console.log("***** FILE UPLOAD DEBUGGING *****");
    console.log("Files received count:", req.files.length);

    // Create Google Drive folder for this request
  console.log("Creating Google Drive folder for the request");
  const folderId = await driveService.createFolder();
  console.log("Folder created with ID:", folderId);


    fileObjects = await uploadBatch(req.files, async (file, index, shouldStop) => {
        // Set expiration date for the file
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + fileExpirationDays);
        
        // Create a Buffer from the file
        const fileBuffer = file.buffer;
        
        // Clean filename and upload to Google Drive
        const safeFilename = file.originalname.replace(/\s+/g, '_');
        
        // Upload file to Google Drive
        console.log(`Uploading file "${safeFilename}" to Google Drive`);
        const uploadedFile = await driveService.uploadFile(
          safeFilename,
          fileBuffer,
          file.mimetype,
          folderId,
          shouldStop
        );
        if (!uploadedFile) return null;

        // Generate direct download link and embedable link for images
      const downloadLink = driveService.getDownloadLink(uploadedFile.id);
      let embedLink = null;
  
       // Handle different file types
      if (file.mimetype.startsWith('image/')) {
        // For images
        embedLink = driveService.getEmbedableImageLink(uploadedFile.id);
      } else if (file.mimetype === 'application/pdf') {
        // For PDFs
        embedLink = driveService.getEmbedableDocumentLink(uploadedFile.id);
      } else if (file.mimetype === 'application/msword' || 
                file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        // For Word documents
        embedLink = driveService.getEmbedableDocumentLink(uploadedFile.id);
      }
        
       // Add file info to the array - make sure each property is the right type
       return {
        filename: safeFilename,
        originalName: file.originalname,
        type: file.mimetype,
        size: file.size,
        driveFileId: uploadedFile.id,
        driveLink: uploadedFile.link,
        downloadLink: downloadLink,
        embedLink: embedLink,
        expirationDate: expirationDate
      };
    }, stored => driveService.deleteFile(stored.driveFileId),
    () => submission.progress(req, { $inc: { completedFiles: 1 } }));
  }
  
  // Create update request document
  let serviceAllowanceReserved = false;
  let requestPersisted = false;
  let committedResponse;
  let updateRequest;
  try {
    console.log("***** DATABASE SAVE DEBUGGING *****");
    console.log("Files object structure:", JSON.stringify(fileObjects));

    if (req.uploadAttempt) {
      await submission.progress(req, { $set: { phase: 'finalizing' } });
      const committed = await submission.commitSubmission(req, {
        instructions: instructions.map(msg => ({ text: msg.text, timestamp: new Date(msg.timestamp || Date.now()) })),
        files: fileObjects,
      });
      committedResponse = committed.response;
      updateRequest = { _id: committed.requestId };
      requestPersisted = true;
    } else {
      if (isServiceUpload) {
        const reservationFilter = {
          _id: new ObjectId(planId),
          userId: new ObjectId(userId),
          servicePlanStatus: 'active',
          isActive: true,
          planStatus: { $ne: 'closed' },
          autoRenewalStatus: { $ne: 'paused' },
        };
        // Same "allowed right now" limit as every other upload path (helpers/serviceAllowance.js).
        const allowanceExpr = require('../../helpers/serviceAllowance').reservationExpr(updatePlan);
        if (allowanceExpr) reservationFilter.$expr = allowanceExpr;
        const reservedOrder = await measureUpload(timing, 'service_allowance_reserve', () => orderModel.findOneAndUpdate(
          reservationFilter,
          { $inc: { serviceAccessUsedInCycle: 1, serviceAccessUsedTotal: 1 } },
          { new: true },
        ).select('_id'));
        if (!reservedOrder) throw new Error('Selected service upload limit or availability changed');
        serviceAllowanceReserved = true;
      }

      // Create the update request
      updateRequest = new updateRequestModel({
        userId: new ObjectId(userId),
        updatePlanId: new ObjectId(planId),
        instructions: instructions.map(msg => ({
          text: msg.text,
          timestamp: new Date(msg.timestamp || Date.now())
        })),
        files: fileObjects,
        status: 'pending'
      });
    
      // Save the request
      await measureUpload(timing, 'request_save', () => updateRequest.save());
      requestPersisted = true;
    
      // Spend the allowance this upload was made against — each kind spends its own, and a
      // project spends nothing at all. A project has no allowance, so incrementing one on it
      // is not just useless but wrong: it left updatesUsed=1 sitting on project orders,
      // a legacy plan's counter on something that has no plan.
      const updateFields = isLegacyUpload
          ? { updatesUsed: 1 }
          : null;

      if (updateFields) {
        // For yearly renewable plans and monthly limited plans, also increment currentMonthUpdatesUsed
        if (updatePlan.productId?.isMonthlyRenewablePlan || updatePlan.productId?.isMonthlyLimitedPlan) {
          updateFields.currentMonthUpdatesUsed = 1;
        }

        // For monthly limited plans, also update the remaining counter
        const updateQuery = { $inc: updateFields };
        if (updatePlan.productId?.isMonthlyLimitedPlan) {
          const effectiveMonthlyLimit =
            updatePlan.currentMonthUpdatesLimit ||
            updatePlan.productId.monthlyUpdateLimit ||
            1;
          const newRemaining = effectiveMonthlyLimit - (updatePlan.currentMonthUpdatesUsed + 1);
          updateQuery.$set = { currentMonthUpdatesRemaining: newRemaining };
        }

        await measureUpload(timing, 'legacy_allowance_update', () => orderModel.updateOne(
          { _id: new ObjectId(planId) },
          updateQuery
        ));
      }

    }
    // Send email notifications
    console.log("Sending email notifications...");
    try {
      const populatedRequest = await measureUpload(timing, 'notification_record_lookup', () => updateRequestModel.findById(updateRequest._id)
        .populate('userId', 'name email')
        .populate({
          path: 'updatePlanId',
          populate: {
            path: 'productId',
            select: 'serviceName validityPeriod updateCount'
          }
        }));
      // Admin emails
      const adminEmails = ['vacomputers.com@gmail.com', 'syncvap@gmail.com'];

      await measureUpload(timing, 'admin_email_prepare', () => sendUpdateRequestNotification(populatedRequest, adminEmails));
      console.log(`Admin notification emails sent to ${adminEmails.length} admins`);
      
      // Send confirmation to user
      await measureUpload(timing, 'client_email_prepare', () => sendUserConfirmation(populatedRequest));
      console.log("User confirmation email sent");
      
      // Create in-app notifications for admins
      await measureUpload(timing, 'in_app_notifications', () => createUpdateRequestNotification(populatedRequest));
      console.log("Admin in-app notifications created");
    } catch (emailError) {
      console.error("Error with notification process:", emailError);
      // Continue execution even if notification fails
    }
    
    timing?.mark('controller_response_ready');
    return res.status(200).json(committedResponse || {
      message: "Update request submitted successfully",
      error: false,
      success: true,
      data: {
        requestId: updateRequest._id,
        // Only a legacy plan has a countable remainder. A service reports its own
        // allowance elsewhere, and a project has none — null says "not applicable"
        // for both, instead of reading a product neither of them has.
        updatesRemaining: isLegacyUpload
          ? updatePlan.productId.updateCount - (updatePlan.updatesUsed + 1)
          : null
      }
    });
  } catch (error) {
    req.uploadCommitUncertain ||= Boolean(error.uploadCommitUncertain);
    if (serviceAllowanceReserved && !requestPersisted) {
      await orderModel.updateOne(
        { _id: new ObjectId(planId) },
        { $inc: { serviceAccessUsedInCycle: -1, serviceAccessUsedTotal: -1 } },
      ).catch((rollbackError) => console.error('Could not release service upload reservation:', rollbackError.message));
    }
    if (!requestPersisted && !error.uploadCommitUncertain) {
      await Promise.all(fileObjects.map((storedFile) => (
        driveService.deleteFile(storedFile.driveFileId).catch((cleanupError) => {
          req.uploadNeedsReview = true;
          console.error('Could not clean up Drive file after failed request:', cleanupError.message);
        })
      )));
    }
    console.error('Database error:', error);
    console.error('Error details:', error.errors ? JSON.stringify(error.errors) : 'No detailed errors');
    return res.status(500).json({
      message: error.message || 'Failed to save update request',
      error: true,
      success: false
    });
  }
});

const submitUpdateRequest = asyncHandler(async (req, res) => {
  const attempt = await submission.claimSubmission(req);
  req.uploadAttempt = attempt;
  if (attempt?.replay) return res.status(200).json(attempt.replay);
  if (attempt?.pending) return res.status(202).json({ success: false, error: false, code: 'UPLOAD_IN_PROGRESS', data: { status: attempt.status } });
  let status = 200;
  const response = {
    status(value) { status = value; return this; },
    async json(payload) {
      if (!payload.success && !req.uploadCommitUncertain) await submission.failSubmission(req, req.uploadNeedsReview);
      return res.status(status).json(payload);
    },
  };
  return submitCore(req, response);
});

module.exports = submitUpdateRequest;
