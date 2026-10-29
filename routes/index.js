const express = require('express')

const router = express.Router()
const websitePreview = require('../controller/order/websitePreview');
const previewAuth = require('../middleware/authToken');
router.get('/projects/:projectId/website-preview', previewAuth, websitePreview.state);
router.patch('/projects/:projectId/website-preview', previewAuth, websitePreview.settings);
router.post('/projects/:projectId/website-preview/uploads', previewAuth, websitePreview.begin);
router.post('/projects/:projectId/website-preview/uploads/:versionId/tokens', previewAuth, websitePreview.batch);
router.post('/projects/:projectId/website-preview/grant', previewAuth, websitePreview.grant);
router.post('/projects/:projectId/website-preview/cleanup', previewAuth, websitePreview.cleanup);
router.post('/website-preview-service/:action', websitePreview.integration);
router.patch('/admin/projects/:orderId/portfolio-source', require('../middleware/authToken'), require('../controller/order/portfolioSettings'));
router.get('/portfolio-integration/sync', require('../controller/order/portfolioSync'));
router.post('/portfolio-integration/sync', require('../controller/order/portfolioSync'));
const upload = require('../middleware/uploadFiles');
const stagedUpload = require('../controller/user/stagedUploadController');
router.get('/upload-sessions', require('../middleware/authToken'), stagedUpload.capabilities);
router.post('/upload-sessions', require('../middleware/authToken'), stagedUpload.begin);
router.get('/upload-sessions/:uploadId', require('../middleware/authToken'), stagedUpload.status);
router.post('/upload-sessions/:uploadId/files/:fileId', require('../middleware/authToken'), stagedUpload.authorizeFile, stagedUpload.parseFile, stagedUpload.receive);
router.post('/upload-sessions/:uploadId/complete', require('../middleware/authToken'), stagedUpload.complete);
router.post('/admin/upload-submissions/:submissionId/retry', require('../middleware/authToken'), stagedUpload.retryDelivery);
// const fs = require('fs');

const userSignUpController = require("../controller/user/userSignUp")
const userSignInController = require("../controller/user/userSignIn")
const userRoleSwitchController = require("../controller/user/userRoleSwitch")
const userDetailsController = require('../controller/user/userDetails')
const addRoleToUserController = require('../controller/user/addRoleToUser')
const authToken = require('../middleware/authToken')
router.use('/offer-reservations', authToken, require('./offerReservations'));
// Website plan page "Get this plan" for a non-client: a signed-in member here, a visitor through the
// website server below (controller/lead/planRequest.js). Clients buy in the portal instead.
router.post('/plan-request', authToken, require('../controller/lead/planRequest').memberPlanRequest);
const userLogout = require('../controller/user/userLogout')
const allUsers = require('../controller/user/allUsers')
const getPartnerCustomers = require('../controller/user/partnerCustomers')
const updateUser = require('../controller/user/updateUser')
const UploadProductController = require('../controller/product/uploadPoduct')
const getProductController = require('../controller/product/getProduct')
const updateProductController = require('../controller/product/updateProduct')
const getProductDetails = require('../controller/product/getProductDetails')
const UploadCategoryController = require('../controller/product/uploadCategory')
const getCategoryController = require('../controller/product/getCategories')
const updateCategoryController = require('../controller/product/updateCategory')
const deleteProductController = require('../controller/product/deleteProduct')
const retireOrDeletePlan = require('../controller/product/retireOrDeletePlan')
const reactivatePlan = require('../controller/product/reactivatePlan')
const purgePlan = require('../controller/product/purgePlan')
const UploadAdController = require('../controller/ads/uploadAd')
const UploadBannerController = require('../controller/ads/uploadBanner')
const getBannersController = require('../controller/ads/getBanner')
const updateBannerController = require('../controller/ads/updateBanner')
const DeleteBannerController = require('../controller/ads/deleteBanner')
const DeleteCategoryController = require('../controller/product/deleteCategory')
const updateUserProfileController = require('../controller/user/updateUserProfileController')
const createOrder = require('../controller/order/createOrder')
const customerCreateServicePlanOrder = require('../controller/order/customerCreateServicePlanOrder')
const customerCreateCustomProjectOrder = require('../controller/order/customerCreateCustomProjectOrder')
const getCustomerCategoryBasePrice = require('../controller/order/getCustomerCategoryBasePrice')
const adminRechargeWallet = require('../controller/user/adminRechargeWallet')
const walletPayInstant = require('../controller/user/walletPayInstant')
const getUserOrders = require('../controller/order/getUserOrder')
const getOrderDetails = require('../controller/order/getOrderDetails')
const projectNodeController = require('../controller/order/projectNodeController')
const stopServiceRenewal = require('../controller/order/stopServiceRenewal')
const getCompatibleFeaturesController = require('../controller/product/getCompatibleFeatures')
const getGuestSlidesController = require('../controller/welcomeBanner/getGuestSlidesController')
const uploadGuestSlidesController = require('../controller/welcomeBanner/uploadGuestSlidesController')
const getUserWelcomeController = require('../controller/welcomeBanner/getUserWelcomeController')
const uploadUserWelcomeController = require('../controller/welcomeBanner/uploadUserWelcomeController')
const updateGuestSlidesController = require('../controller/welcomeBanner/updateGuestSlidesController')
const updateUserWelcomeController = require('../controller/welcomeBanner/updateUserWelcomeController')
const deleteUserWelcomeController = require('../controller/welcomeBanner/deleteUserWelcomeController')
const deleteGuestSlidesController = require('../controller/welcomeBanner/deleteGuestSlidesController')
const submitUpdateRequest = require('../controller/user/submitUpdateRequest');
const getUserUpdateRequests = require('../controller/user/getUserUpdateRequests');
const getOrderUploads = require('../controller/order/getOrderUploads');
const downloadUploadRequestZip = require('../controller/order/downloadUploadRequestZip');
const verifyPaymentController = require('../controller/user/verifyPaymentController');
const getWalletHistory = require('../controller/user/getWalletHistory');
const { approveTransaction, rejectTransaction } = require('../controller/user/transactionApprovalController');
const validateCoupon = require('../controller/user/validateCoupon');
const payInstallment = require('../controller/user/payInstallment');
const getUserNotifications = require('../controller/user/getUserNotificationsController');
const verifyOtpController = require('../controller/user/verifyOtpController');
const resendOtpController = require('../controller/user/resendOtpController');
const downloadInvoice = require('../controller/user/downloadInvoice');
const createTicketController = require('../controller/user/createTicketController');
const getUserTicketsController = require('../controller/user/getUserTicketsController');
const getTicketDetailsController = require('../controller/user/getTicketDetailsController');
const replyTicketController = require('../controller/user/replyTicketController');
const getGeneralUsers = require('../controller/user/getGeneralUsers');
const getAdminClients = require('../controller/user/getAdminClients');
const getAdminUserWorkspace = require('../controller/user/getAdminUserWorkspace');
const getMyPaymentWorkspace = require('../controller/user/getMyPaymentWorkspace');
const deleteOrderController = require('../controller/order/deleteOrder');
const scanDeleteOrderController = require('../controller/order/scanDeleteOrder');
const adminCreateProjectOrderController = require('../controller/order/adminCreateProjectOrder');
const adminWebsiteOffersController = require('../controller/order/adminWebsiteOffers');
const approveProjectOrderController = require('../controller/order/approveProjectOrder');
const { cancelProjectOrder, getProjectCancellationPreview } = require('../controller/order/cancelProjectOrder');
const { resendProjectFinalInvoice } = require('../controller/invoice/projectFinalInvoiceController');
const { viewInvoiceDocument, downloadInvoiceDocument } = require('../controller/invoice/invoiceDocumentController');
const getCategoryBasePricesController = require('../controller/admin/getCategoryBasePrices');
const updateCategoryBasePriceController = require('../controller/admin/updateCategoryBasePrice');
const getMessageTemplatesController = require('../controller/admin/getMessageTemplates');
const createMessageTemplateController = require('../controller/admin/createMessageTemplate');
const updateMessageTemplateController = require('../controller/admin/updateMessageTemplate');
const deleteMessageTemplateController = require('../controller/admin/deleteMessageTemplate');
const createLeadController = require('../controller/lead/createLead');
const guestLoginController = require('../controller/user/guestLogin');
const guestDummyWalletCreditController = require('../controller/user/guestDummyWalletCredit');
const getLeadsController = require('../controller/lead/getLeads');
const getLeadDetailController = require('../controller/lead/getLeadDetail');
const updateLeadController = require('../controller/lead/updateLead');
const deleteLeadController = require('../controller/lead/deleteLead');
const globalSearchController = require('../controller/lead/globalSearch');
const searchCustomersController = require('../controller/user/searchCustomers');
const myReferredLeadsController = require('../controller/user/myReferredLeads');
const getAdminSettingsController = require('../controller/admin/getAdminSettings');
const updateAdminSettingsController = require('../controller/admin/updateAdminSettings');
const convertLeadController = require('../controller/lead/convertLead');
const setNewPasswordController = require('../controller/user/setNewPassword');
const uploadProposalController = require('../controller/lead/uploadProposal');
const uploadClientDocumentController = require('../controller/user/uploadClientDocument');
const getClientDocumentsController = require('../controller/user/getClientDocuments');
const getAdminClientDocumentsController = require('../controller/user/getAdminClientDocuments');
const trashClientController = require('../controller/trash/trashClient');
const getTrashController = require('../controller/trash/getTrash');
const restoreTrashController = require('../controller/trash/restoreTrash');
const purgeTrashController = require('../controller/trash/purgeTrash');
const getClientCredentialsController = require('../controller/admin/getClientCredentials');
const resetClientPasswordController = require('../controller/admin/resetClientPassword');
const updateClientAccountStatusController = require('../controller/admin/updateClientAccountStatus');
const externalUploadLinkController = require('../controller/user/externalUploadLinkController');
const externalUploadController = require('../controller/user/externalUploadController');
const hideProductController = require('../controller/product/hideProduct');
const unhideProductController = require('../controller/product/unhideProduct');
const getHiddenProductsController = require('../controller/product/getHiddenProducts');
const getAllProductsController = require('../controller/product/getAllProducts');
const getAdminPlanProductsController = require('../controller/product/getAdminPlanProducts');
const getAdminFeatureProductsController = require('../controller/product/getAdminFeatureProducts');
const createServicePlanController = require('../controller/product/createServicePlan');
const completeUserDetailsController = require('../controller/user/completeUserDetailsController');
const updatePartnerCustomer = require('../controller/user/updatePartnerCustomer');
const { addBankAccount, updateBankAccount, deleteBankAccount, getBankAccounts } = require('../controller/user/bankAccountController');
const getUserKycStatusController = require('../controller/user/getUserKycStatusController');

// Existing monthly bill payment/document handlers
const {
  markInvoiceAsPaid,
  getPaymentRecordDetail,
  downloadPaymentRecordInvoice,
  resendPaymentRecordInvoice,
  sendPaymentRecordReminder,
} = require('../controller/invoice/monthlyInvoiceController');

//user
router.post("/signup", userSignUpController);
router.get("/phone-countries", (req, res) => res.json({ success: true, error: false, data: require('../helpers/phoneNumber').PHONE_COUNTRIES }));
router.post("/guest-login", guestLoginController);
router.post("/guest/demo-wallet-credit", authToken, guestDummyWalletCreditController);

router.get("/partner-customers", authToken, getPartnerCustomers);
router.post("/signin", userSignInController);
router.get("/general-users", getGeneralUsers);
router.get("/admin/clients", authToken, getAdminClients);
router.get("/admin/plan-products", authToken, getAdminPlanProductsController);
router.get("/admin/feature-products", authToken, getAdminFeatureProductsController);
router.post("/admin/services/create", authToken, createServicePlanController);
router.get("/admin/user-workspace", authToken, getAdminUserWorkspace);
router.get("/admin/clients/:customerId/upload-links", authToken, externalUploadLinkController.list);
router.post("/admin/clients/:customerId/upload-links", authToken, externalUploadLinkController.generate);
router.post("/admin/clients/:customerId/upload-links/:linkId/revoke", authToken, externalUploadLinkController.revoke);
router.post("/external-upload/exchange", externalUploadController.requireAllowedOrigin, externalUploadController.exchange);
router.post("/external-upload/credentials", externalUploadController.requireAllowedOrigin, externalUploadController.verifyCredentials);
router.get("/external-upload/session", externalUploadController.getSession);
router.get('/external-upload/uploads', externalUploadController.requireAccess, stagedUpload.capabilities);
router.post('/external-upload/uploads', externalUploadController.requireAllowedOrigin, externalUploadController.requireAccess, externalUploadController.reserveSingleUse, stagedUpload.begin);
router.get('/external-upload/uploads/:uploadId', externalUploadController.requireAccess, stagedUpload.status);
router.post('/external-upload/uploads/:uploadId/files/:fileId', externalUploadController.requireAllowedOrigin, externalUploadController.requireAccess, stagedUpload.authorizeFile, stagedUpload.parseFile, stagedUpload.receive);
router.post('/external-upload/uploads/:uploadId/complete', externalUploadController.requireAllowedOrigin, externalUploadController.requireAccess, stagedUpload.complete);
router.get('/external-upload/progress/:uploadId', externalUploadController.requireAccess, require('../controller/user/getUploadProgress'));
router.post(
  "/external-upload/submit",
  externalUploadController.requireAllowedOrigin,
  externalUploadController.requireAccess,
  externalUploadController.reserveSingleUse,
  externalUploadController.parseFiles,
  externalUploadController.submit,
);
router.get("/my-payment-workspace", authToken, getMyPaymentWorkspace);
router.get("/admin/delete-order/:orderId/scan", authToken, scanDeleteOrderController);
router.delete("/admin/delete-order/:orderId", authToken, deleteOrderController);
router.post("/admin/clients/:customerId/create-project", authToken, adminCreateProjectOrderController);
router.get("/admin/website-offers", authToken, adminWebsiteOffersController);
router.get('/admin/sales-packages', authToken, require('../controller/order/salesPackagesController').adminRead);
router.patch('/admin/sales-packages', authToken, require('../controller/order/salesPackagesController').adminSave);
router.patch('/admin/sales-packages/offer-links', authToken, require('../controller/order/salesPackagesController').adminLinkOffer);
router.patch('/admin/sales-packages/page-unlink', authToken, require('../controller/order/salesPackagesController').adminUnlinkPage);
router.get('/integration/sales-packages', require('../controller/order/salesPackagesController').integrationRead);
// Flexible Plans: public plan catalogue + estimator quote for the website (bearer, helpers/integrationAuth.js).
router.get('/integration/plan-catalogue', require('../controller/order/servicePlanQuote').integrationCatalogue);
router.patch('/integration/plan-catalogue/quote', require('../controller/order/servicePlanQuote').integrationQuote);
router.patch('/integration/plan-request', require('../controller/lead/planRequest').integrationPlanRequest);
router.post("/admin/clients/:customerId/documents", authToken, upload.any(), uploadClientDocumentController);
router.get("/admin/clients/:customerId/documents", authToken, getAdminClientDocumentsController);
router.get("/admin/clients/:customerId/credentials", authToken, getClientCredentialsController);
router.post("/admin/clients/:customerId/reset-password", authToken, resetClientPasswordController);
router.post("/admin/clients/:customerId/account-status", authToken, updateClientAccountStatusController);
router.post("/admin/projects/:orderId/approval", authToken, approveProjectOrderController);
// Cancellation runs before deletion so the money is settled while the payment records still
// exist. The preview is read-only — it tells the admin what will be refunded and which methods
// need a reference id before anything is written.
router.get("/admin/projects/:orderId/cancel-preview", authToken, getProjectCancellationPreview);
router.post("/admin/projects/:orderId/cancel", authToken, cancelProjectOrder);
router.post("/admin/clients/:customerId/recharge-wallet", authToken, adminRechargeWallet);
router.get("/admin/category-base-prices", authToken, getCategoryBasePricesController);
router.post("/admin/category-base-prices", authToken, updateCategoryBasePriceController);
// Plan categories (helpers/planCategories.js); GET/PATCH for the website admin's salesBackend().
router.get("/admin/plan-categories", authToken, require('../controller/admin/planCategories').listPlanCategoriesController);
router.patch("/admin/plan-categories", authToken, require('../controller/admin/planCategories').savePlanCategoryController);
router.get("/admin/plan-catalogue", authToken, require('../controller/admin/planCatalogue').listPlanCatalogueController);
router.patch("/admin/plan-catalogue", authToken, require('../controller/admin/planCatalogue').savePlanController);
router.patch("/admin/plan-catalogue/quote", authToken, require('../controller/admin/planCatalogue').quotePlanController);
// Flexible Plans admin actions (controller/admin/servicePlanAdmin.js).
router.post("/admin/clients/:customerId/service-plans", authToken, require('../controller/admin/servicePlanAdmin').startPlanForClient);
router.patch("/admin/service-plans/:orderId/release-mode", authToken, require('../controller/admin/servicePlanAdmin').setReleaseMode);
router.post("/admin/service-plans/:orderId/work-updates", authToken, require('../controller/admin/servicePlanAdmin').addWorkUpdate);
router.post("/admin/uploads/:requestId/status", authToken, require('../controller/admin/servicePlanAdmin').setUploadStatusController);
router.get("/admin/message-templates", authToken, getMessageTemplatesController);
router.post("/admin/message-templates", authToken, createMessageTemplateController);
router.put("/admin/message-templates/:templateId", authToken, updateMessageTemplateController);
router.delete("/admin/message-templates/:templateId", authToken, deleteMessageTemplateController);
router.get("/admin/leads", authToken, getLeadsController);
router.post("/admin/leads", authToken, createLeadController);
router.get("/admin/search", authToken, globalSearchController);
router.get("/admin/customers/search", authToken, searchCustomersController);
router.get("/admin/settings", authToken, getAdminSettingsController);
router.post("/admin/settings", authToken, updateAdminSettingsController);
router.get("/my-referred-leads", authToken, myReferredLeadsController);
router.get("/admin/leads/:leadId", authToken, getLeadDetailController);
router.post("/admin/leads/:leadId", authToken, upload.any(), updateLeadController);
router.delete("/admin/leads/:leadId", authToken, deleteLeadController);
router.post("/admin/leads/:leadId/convert", authToken, convertLeadController);
router.post("/admin/leads/:leadId/proposal", authToken, upload.any(), uploadProposalController);
// Trash (soft-delete) system — admin only. Lead trash reuses the DELETE /admin/leads/:leadId
// route above (now soft-deletes). Distinct /admin/trash* paths, no shadowing.
router.post("/admin/clients/:customerId/trash", authToken, trashClientController);
router.get("/admin/trash", authToken, getTrashController);
router.post("/admin/trash/:type/:id/restore", authToken, restoreTrashController);
router.delete("/admin/trash/:type/:id", authToken, purgeTrashController);
router.post("/set-new-password", authToken, setNewPasswordController);
router.get("/my-documents", authToken, getClientDocumentsController);
router.post('/verify-otp', verifyOtpController);
router.post('/resend-otp', resendOtpController);
router.post("/role-switch", authToken, userRoleSwitchController);
router.get("/user-details", authToken, userDetailsController)
router.get("/userLogout", userLogout)
router.post("/update-profile", authToken, updateUserProfileController);
router.post("/my-upload-link-preference", authToken, externalUploadLinkController.updatePreference);
router.post("/complete-profile", authToken, completeUserDetailsController);
router.post("/update-partner-customer/:customerId", authToken, updatePartnerCustomer);

// Add role to user
router.post("/addRole", authToken, addRoleToUserController)
router.post("/user-request-update", authToken, upload.any(), submitUpdateRequest)
router.get('/upload-progress/:uploadId', authToken, require('../controller/user/getUploadProgress'));
router.get("/get-update-requests", authToken, getUserUpdateRequests)
// Uploaded-data surface. One pair of routes for customer and admin alike — each
// authorises internally (admin reads any order, everyone else only their own), so the
// two sides can never see a different history or a different set of downloadable files.
router.get("/orders/:orderId/uploads", authToken, getOrderUploads)
router.get("/uploads/:requestId/download", authToken, downloadUploadRequestZip)
router.post("/validate-coupon", authToken, validateCoupon)
router.post("/pay-installment", authToken, payInstallment)
router.get("/user-notifications", authToken, getUserNotifications);
router.get('/download-invoice/:orderId', authToken, downloadInvoice);
router.post("/create-ticket", authToken, createTicketController);
router.get("/get-user-tickets", authToken, getUserTicketsController);
router.get("/get-ticket-details/:ticketId", authToken, getTicketDetailsController);
router.post("/ticket-reply/:ticketId", authToken, replyTicketController);
router.post("/add-bank-account", authToken, addBankAccount);
router.post("/update-bank-account/:accountId", authToken, updateBankAccount);
router.delete("/delete-bank-account/:accountId", authToken, deleteBankAccount);
router.get("/get-bank-accounts", authToken, getBankAccounts);
router.get("/user-kyc-status", authToken, getUserKycStatusController);

router.get("/wallet/history", authToken, getWalletHistory)
router.post("/wallet/verify-payment", authToken, verifyPaymentController)
router.post("/wallet/pay-instant", authToken, walletPayInstant)
router.post("/wallet/approve-transaction", authToken, approveTransaction)
router.post("/wallet/reject-transaction", authToken, rejectTransaction)

// product
router.post("/upload-product", authToken, UploadProductController )
router.get("/get-product",getProductController)
router.post("/update-product", authToken, updateProductController)
router.delete("/delete-product", authToken, deleteProductController)
// Smart removal: deletes an unpurchased plan, retires one customers already bought.
router.delete("/admin/plans/:planId", authToken, retireOrDeletePlan)
router.post("/admin/plans/:planId/reactivate", authToken, reactivatePlan)
// "Delete Forever" from the Retired tab. Archives by default; hard-deletes only
// with mode:"hard" plus a typed confirmation of the plan name.
router.post("/admin/plans/:planId/purge", authToken, purgePlan)
router.post("/product-details", getProductDetails)
router.post("/upload-category",authToken, UploadCategoryController)
router.get("/get-categories", getCategoryController)
router.post("/update-category/:id",authToken, updateCategoryController)
router.delete("/delete-category", authToken, DeleteCategoryController)
router.get("/compatible-features", getCompatibleFeaturesController);
router.post("/hide-product", authToken, hideProductController);
router.post("/unhide-product", authToken, unhideProductController);
router.get("/get-hidden-products", authToken, getHiddenProductsController);
router.get("/all-products", authToken, getAllProductsController);

// payment and order
router.post("/create-order", authToken, createOrder)
// Service Plan purchase — standalone, or as an add-on attached to a project.
// Single service: wallet, UPI or combined. Bulk: wallet only (doc 55 §10).
router.post("/customer/service-plan-order", authToken, customerCreateServicePlanOrder)
router.post("/customer/service-plan-quote", authToken, require('../controller/order/servicePlanQuote').customerQuote)
router.get('/customer/service-plan-catalogue', authToken, require('../controller/order/servicePlanQuote').customerCatalogue)
router.get('/customer/service-plan-offers/:planId', authToken, require('../controller/order/servicePlanOffers'))
router.post("/customer/custom-project-order", authToken, customerCreateCustomProjectOrder)
router.get("/customer/category-base-price", authToken, getCustomerCategoryBasePrice)
router.get("/customer/project-categories", authToken, require('../controller/order/getCustomerProjectCategories'))
// Get a Service → Start a Project: callback request saved as a lead.
router.get("/customer/project-request/categories", authToken, require('../controller/lead/customerProjectRequest').getProjectRequestCategories)
router.post("/customer/project-request", authToken, require('../controller/lead/customerProjectRequest').createProjectRequest)
router.post("/customer/service-plan/stop-renewal", authToken, stopServiceRenewal)

// Existing monthly bill settlement
router.post("/invoices/:invoiceId/mark-paid", authToken, markInvoiceAsPaid)
// One document surface for every invoice, customer and admin alike. The admin-only
// /admin/project-final-invoices download|view pair was retired into these two — it rendered the
// same invoice through a second generator, which is what let the two sides drift apart.
router.get("/invoices/:invoiceId/view", authToken, viewInvoiceDocument)
router.get("/invoices/:invoiceId/download", authToken, downloadInvoiceDocument)
router.post("/admin/project-final-invoices/:invoiceId/resend", authToken, resendProjectFinalInvoice)
router.get("/admin/clients/:customerId/payment-records/:recordType/:recordId", authToken, getPaymentRecordDetail)
router.get("/admin/clients/:customerId/payment-records/:recordType/:recordId/download-invoice", authToken, downloadPaymentRecordInvoice)
router.post("/admin/clients/:customerId/payment-records/:recordType/:recordId/resend-invoice", authToken, resendPaymentRecordInvoice)
router.post("/admin/clients/:customerId/payment-records/:recordType/:recordId/reminder", authToken, sendPaymentRecordReminder)

router.get("/get-order", authToken, getUserOrders)
router.get("/order-details/:orderId", authToken, getOrderDetails)
router.post("/admin/projects/:orderId/nodes", authToken, projectNodeController.createProjectNode)
router.post("/admin/projects/:orderId/nodes/edit", authToken, projectNodeController.editProjectNode)
router.post("/admin/projects/:orderId/nodes/delete", authToken, projectNodeController.deleteProjectNodes)
router.post("/admin/projects/:orderId/nodes/restore", authToken, projectNodeController.restoreProjectNodes)
router.post("/admin/projects/:orderId/nodes/visibility", authToken, projectNodeController.setProjectNodeVisibility)
router.post("/admin/projects/:orderId/nodes/reset", authToken, projectNodeController.resetProjectNodes)

// ads
router.post("/upload-ad", authToken, UploadAdController)
router.post("/upload-banner", authToken, UploadBannerController)
router.get("/get-banner", getBannersController)
router.post("/update-banner/:id", authToken, updateBannerController)
router.delete("/delete-banner", authToken, DeleteBannerController)

// welcome banner
router.get("/get-guest-slides", getGuestSlidesController)
router.post("/upload-guest-slides", authToken, uploadGuestSlidesController)
router.post("/update-guest-slides/:id", authToken, updateGuestSlidesController)
router.delete("/delete-guest-slides/:id", authToken, deleteGuestSlidesController)

// User Welcome Routes
router.get("/get-user-welcome", getUserWelcomeController)
router.post("/upload-user-welcome", authToken, uploadUserWelcomeController)
router.post("/update-user-welcome/:id", authToken, updateUserWelcomeController)
router.delete("/delete-user-welcome/:id", authToken, deleteUserWelcomeController)

module.exports = router;
