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
const {
  MAX_LEGACY_UPDATE_FILES_PER_UPLOAD,
  MAX_PROJECT_FILES_PER_UPLOAD,
} = require('../../config/uploadLimits');
const { UPLOAD_KIND, getUploadKind } = require('../../helpers/uploadType');
const { assertProjectAcceptsUpload } = require('../../helpers/projectUploadGate');

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
    console.error('Error in async handler:', err);
    return res.status(500).json({
      message: err.message || 'Internal server error',
      error: true,
      success: false
    });
  });
};

const submitUpdateRequest = asyncHandler(async (req, res) => {
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
  const updatePlan = await orderModel.findOne({
    _id: planId,
    userId
  }).populate('productId');

  if (!updatePlan) {
    return res.status(404).json({
      message: 'Update plan not found',
      error: true,
      success: false
    });
  }
  // Which of the three kinds of upload is this? Asked once, from the one place that
  // answers it (helpers/uploadType.js), because the rest of this controller then reads
  // a DIFFERENT source of allowance per kind — and reading the wrong one is precisely
  // the bug this replaces: a project has no catalogue product, so the legacy branch's
  // `updatePlan.productId.updateCount` threw "Cannot read properties of null".
  const uploadKind = getUploadKind(updatePlan);
  const isServiceUpload = uploadKind === UPLOAD_KIND.SERVICE;
  const isProjectUpload = uploadKind === UPLOAD_KIND.PROJECT;

  if (isServiceUpload) {
    // Allowance comes from the snapshot frozen on the order, never the catalogue.
    const snapshot = updatePlan.servicePlanSnapshot || {};
    if (String(req.body.serviceOrderId || '') !== String(updatePlan._id)) throw new Error('Selected service is required');
    if (snapshot.capability !== 'upload_data' && snapshot.serviceBehavior !== 'portal_access_control') throw new Error('This service does not allow data upload');
    if (updatePlan.servicePlanStatus !== 'active') throw new Error('This service is not active');
    if (snapshot.limitScope !== 'unlimited' && Number(updatePlan.serviceAccessUsedInCycle || 0) >= Number(snapshot.portalAccessCount || 0)) throw new Error('Selected service upload limit is used');
    if ((req.files || []).length > Number(snapshot.filesLimit || 0)) throw new Error(`This service allows up to ${snapshot.filesLimit} files per upload`);
  } else if (isProjectUpload) {
    // A project has NO allowance to check: portal access during development is unlimited,
    // there is no plan template behind it and no counter to spend. What gates it is the
    // project's own state — the same four conditions ProjectDetails.js uses to disable the
    // button, enforced here too because this route is reachable directly.
    const refusal = await assertProjectAcceptsUpload(updatePlan);
    if (refusal) {
      return res.status(400).json({ message: refusal, error: true, success: false });
    }
    if ((req.files || []).length > MAX_PROJECT_FILES_PER_UPLOAD) {
      throw new Error(`Up to ${MAX_PROJECT_FILES_PER_UPLOAD} files are allowed per upload`);
    }
  } else if ((req.files || []).length > MAX_LEGACY_UPDATE_FILES_PER_UPLOAD) {
    throw new Error(`This plan allows up to ${MAX_LEGACY_UPDATE_FILES_PER_UPLOAD} files per upload`);
  }

  // Check if plan is closed
  if (updatePlan.planStatus === 'closed') {
    return res.status(400).json({
      message: 'This plan has been closed and cannot accept updates',
      error: true,
      success: false
    });
  }

  if (updatePlan.autoRenewalStatus === 'paused') {
    return res.status(400).json({
      message: 'This plan is paused because an invoice payment is overdue. Please clear the payment to request updates.',
      error: true,
      success: false
    });
  }

  if (!updatePlan.isActive) {
    return res.status(400).json({
      message: 'This plan is not active and cannot accept updates',
      error: true,
      success: false
    });
  }
  
  // ── Legacy plan allowance ──────────────────────────────────────────────────────
  // Everything below reads the CATALOGUE product (updatePlan.productId), which only a
  // legacy website_updates plan has. Services answer from their snapshot above; projects
  // have no product at all. Both are excluded here rather than each check restating a
  // guard — the missing guard on the monthly-plan check below is what let a project read
  // a null product and crash.
  const isLegacyUpload = uploadKind === UPLOAD_KIND.LEGACY;

  // Check if the user has updates remaining
  if (isLegacyUpload && updatePlan.updatesUsed >= updatePlan.productId.updateCount) {
    return res.status(400).json({
      message: 'No updates remaining in this plan',
      error: true,
      success: false
    });
  }

  // NEW: Check for monthly limited plans
  if (isLegacyUpload && updatePlan.productId.isMonthlyLimitedPlan) {
    // Use one effective limit source so validation and counters stay in sync.
    const monthlyLimit =
      updatePlan.currentMonthUpdatesLimit ||
      updatePlan.productId.monthlyUpdateLimit ||
      1;
    const monthlyUsed = updatePlan.currentMonthUpdatesUsed || 0;

    if (monthlyUsed >= monthlyLimit) {
      const resetDate = updatePlan.monthlyLimitResetDate || updatePlan.currentMonthExpiryDate;
      return res.status(400).json({
        message: `You have used all ${monthlyLimit} updates for this month. Next reset on ${resetDate ? new Date(resetDate).toLocaleDateString('en-GB') : 'next renewal'}`,
        error: true,
        success: false
      });
    }

    // Check if current month has expired
    if (updatePlan.currentMonthExpiryDate && new Date() > new Date(updatePlan.currentMonthExpiryDate)) {
      return res.status(400).json({
        message: 'Your monthly period has expired. Please renew to continue.',
        error: true,
        success: false
      });
    }

    // Check if yearly duration is exhausted
    if (updatePlan.totalYearlyDaysRemaining !== undefined && updatePlan.totalYearlyDaysRemaining <= 0) {
      return res.status(400).json({
        message: 'Your yearly plan has ended. Please purchase a new plan.',
        error: true,
        success: false
      });
    }
  }

  // Check if the plan is still valid (for regular plans)
  if (isLegacyUpload && !updatePlan.productId.isMonthlyRenewablePlan && !updatePlan.productId.isMonthlyLimitedPlan) {
    const validityInDays = updatePlan.productId.validityPeriod;
    const startDate = new Date(updatePlan.createdAt);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + validityInDays);

    if (new Date() > endDate) {
      return res.status(400).json({
        message: 'Update plan has expired',
        error: true,
        success: false
      });
    }
  }
  
  // Initialize Google Drive service
  const driveService = new GoogleDriveService(KEY_FILE_PATH, FOLDER_NAME);
  
  // Get file expiration days from admin settings
  const adminSettings = await AdminSettings.getSettings();
  const fileExpirationDays = adminSettings.fileExpirationDays;
  
  // Process uploaded files and upload to Google Drive
  const fileObjects = [];
  if (req.files && req.files.length > 0) {
    console.log("***** FILE UPLOAD DEBUGGING *****");
    console.log("Files received count:", req.files.length);

    // Create Google Drive folder for this request
  console.log("Creating Google Drive folder for the request");
  const folderId = await driveService.createFolder();
  console.log("Folder created with ID:", folderId);


    for (const file of req.files) {
      try {
        // Set expiration date for the file
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + fileExpirationDays);
        
        // Create a Buffer from the file
        const fileBuffer = Buffer.from(file.buffer);
        
        // Clean filename and upload to Google Drive
        const safeFilename = file.originalname.replace(/\s+/g, '_');
        
        // Upload file to Google Drive
        console.log(`Uploading file "${safeFilename}" to Google Drive`);
        const uploadedFile = await driveService.uploadFile(
          safeFilename,
          fileBuffer,
          file.mimetype,
          folderId
        );

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
       fileObjects.push({
        filename: safeFilename,
        originalName: file.originalname,
        type: file.mimetype,
        size: file.size,
        driveFileId: uploadedFile.id,
        driveLink: uploadedFile.link,
        downloadLink: downloadLink,
        embedLink: embedLink,
        expirationDate: expirationDate
      });
        
      console.log(`Uploaded file: ${file.originalname} to Google Drive with ID: ${uploadedFile.id}`);
      } catch (error) {
        console.error('Error processing file:', error);
        console.error('File type:', file.mimetype, 'File name:', file.originalname);
        await Promise.all(fileObjects.map((storedFile) => (
          driveService.deleteFile(storedFile.driveFileId).catch((cleanupError) => {
            console.error('Could not clean up Drive file after failed upload:', cleanupError.message);
          })
        )));
        throw error;
      }
    }
  }
  
  // Create update request document
  let serviceAllowanceReserved = false;
  let requestPersisted = false;
  try {
    console.log("***** DATABASE SAVE DEBUGGING *****");
    console.log("Files object structure:", JSON.stringify(fileObjects));

    if (isServiceUpload) {
      const snapshot = updatePlan.servicePlanSnapshot || {};
      const reservationFilter = {
        _id: new ObjectId(planId),
        userId: new ObjectId(userId),
        servicePlanStatus: 'active',
        isActive: true,
        planStatus: { $ne: 'closed' },
        autoRenewalStatus: { $ne: 'paused' },
      };
      if (snapshot.limitScope !== 'unlimited') {
        reservationFilter.$expr = {
          $lt: [
            { $ifNull: ['$serviceAccessUsedInCycle', 0] },
            Number(snapshot.portalAccessCount || 0),
          ],
        };
      }
      const reservedOrder = await orderModel.findOneAndUpdate(
        reservationFilter,
        { $inc: { serviceAccessUsedInCycle: 1, serviceAccessUsedTotal: 1 } },
        { new: true },
      ).select('_id');
      if (!reservedOrder) throw new Error('Selected service upload limit or availability changed');
      serviceAllowanceReserved = true;
    }

    // Create the update request
    const updateRequest = new updateRequestModel({
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
    await updateRequest.save();
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

      await orderModel.updateOne(
        { _id: new ObjectId(planId) },
        updateQuery
      );
    }

    // Send email notifications
    console.log("Sending email notifications...");
    try {
      const populatedRequest = await updateRequestModel.findById(updateRequest._id)
        .populate('userId', 'name email')
        .populate({
          path: 'updatePlanId',
          populate: {
            path: 'productId',
            select: 'serviceName validityPeriod updateCount'
          }
        });
      // Admin emails
      const adminEmails = ['vacomputers.com@gmail.com', 'syncvap@gmail.com'];

      await sendUpdateRequestNotification(populatedRequest, adminEmails);
      console.log(`Admin notification emails sent to ${adminEmails.length} admins`);
      
      // Send confirmation to user
      await sendUserConfirmation(populatedRequest);
      console.log("User confirmation email sent");
      
      // Create in-app notifications for admins
      await createUpdateRequestNotification(populatedRequest);
      console.log("Admin in-app notifications created");
    } catch (emailError) {
      console.error("Error with notification process:", emailError);
      // Continue execution even if notification fails
    }
    
    return res.status(200).json({
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
    if (serviceAllowanceReserved && !requestPersisted) {
      await orderModel.updateOne(
        { _id: new ObjectId(planId) },
        { $inc: { serviceAccessUsedInCycle: -1, serviceAccessUsedTotal: -1 } },
      ).catch((rollbackError) => console.error('Could not release service upload reservation:', rollbackError.message));
    }
    if (!requestPersisted) {
      await Promise.all(fileObjects.map((storedFile) => (
        driveService.deleteFile(storedFile.driveFileId).catch((cleanupError) => {
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

module.exports = submitUpdateRequest;
