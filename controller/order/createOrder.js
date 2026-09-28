const orderProductModel = require("../../models/orderProductModel");
const productModel = require("../../models/productModel");
const categoryBasePriceModel = require("../../models/categoryBasePriceModel");
const { sendAdminUPIPendingNotification } = require("../../helpers/emailService");
const { initializeProjectTimeline } = require("../../helpers/projectNodeService");
// SSOT: shared invoice builder — same helper used by the admin/customer custom-project
// and approval flows, so every project order carries one unpaid invoice.
const { createProjectInvoice } = require("../../helpers/paymentRecording");

const DEFAULT_STARTING_NODE_TITLE = "Project Started";

const createOrder = async (req, res) => {
  try {
    // Only choices come from the body. Every amount (price, discount, installments) is
    // re-derived from productModel below, and no order is ever marked paid here — money
    // moves only when an admin approves the pending transaction.
    const {
      productId,
      isPartialPayment,
      selectedFeatures,
    } = req.body;

    const userId = req.userId;
    const quantity = 1;

    // Fetch product details
    const product = await productModel.findById(productId);
if (!product) {
  console.error(`Product not found with ID: ${productId}`);
  return res.status(404).json({
    success: false,
    message: "Product not found"
  });
}

console.log('Product full data:', JSON.stringify(product));
console.log('Product category from DB:', product.category);

    // Check if it's a website service
    const isWebsiteService = ['standard_websites', 'dynamic_websites', 'cloud_software_development']
      .includes(product.category);
    const isWebsiteUpdate = product.category === 'website_updates';
    const isYearlyRenewablePlan = product.isMonthlyRenewablePlan || false;

    // Feature lines priced from productModel; a quantity from the body is clamped to >= 1
    // so a negative/zero count cannot lower the total.
    let featureItems = [];
    if (Array.isArray(selectedFeatures) && selectedFeatures.length > 0) {
      const featureIds = selectedFeatures.map(feature =>
        typeof feature === 'object' ? feature.id : feature
      );

      const features = await productModel.find({ _id: { $in: featureIds } });

      featureItems = features.map(feature => {
        const selectedFeature = selectedFeatures.find(f =>
          (typeof f === 'object' && f.id === feature._id.toString()) ||
          f === feature._id.toString()
        );

        const requestedQuantity = selectedFeature && typeof selectedFeature === 'object'
          ? Math.floor(Number(selectedFeature.quantity))
          : 1;
        const featureQuantity = Number.isFinite(requestedQuantity) && requestedQuantity >= 1 ? requestedQuantity : 1;

        const isAddNewPage = feature.serviceName.toLowerCase().includes('add new page');

        // "Add New Page" charges only for pages beyond the ones the product includes
        const additionalQuantity = isAddNewPage
          ? Math.max(0, featureQuantity - (product.totalPages || 0))
          : 0;

        const featurePrice = isAddNewPage
          ? feature.sellingPrice * additionalQuantity
          : feature.sellingPrice * featureQuantity;

        return {
          id: feature._id.toString(),
          name: feature.serviceName,
          type: 'feature',
          quantity: featureQuantity,
          originalPrice: feature.sellingPrice,
          finalPrice: featurePrice,
          additionalQuantity: additionalQuantity
        };
      });
    }

    const orderTotal = Number(product.sellingPrice || 0) +
      featureItems.reduce((sum, item) => sum + Number(item.finalPrice || 0), 0);

    // Same 30/30/40 split the checkout page shows; the last installment absorbs rounding.
    const installmentAmounts = isPartialPayment
      ? (() => {
          const first = Math.round(orderTotal * 0.3);
          const second = Math.round(orderTotal * 0.3);
          return [first, second, orderTotal - first - second];
        })()
      : null;

    // Amount due now: the first installment for a partial order, else the full total.
    const price = isPartialPayment ? installmentAmounts[0] : orderTotal;

    let orderData = {
      userId,
      productId,
      quantity,
      price,
      originalPrice: orderTotal,
      isWebsiteProject: isWebsiteService,
      isActive: isWebsiteUpdate,
      orderVisibility: 'pending-approval',
      paymentComplete: false,
      orderItems: [
        {
          id: productId,
          name: product.serviceName,
          type: 'main',
          quantity: quantity,
          originalPrice: product.sellingPrice,
          finalPrice: product.sellingPrice
        },
        ...featureItems
      ]
    };

    if (isPartialPayment) {
      orderData.isPartialPayment = true;
      orderData.currentInstallment = 1;
      orderData.totalAmount = orderTotal;
      orderData.paidAmount = 0;
      orderData.remainingAmount = orderTotal;

      const percentages = [30, 30, 40];
      orderData.installments = installmentAmounts.map((amount, index) => ({
        installmentNumber: index + 1,
        percentage: percentages[index],
        amount,
        paid: false,
        paymentStatus: index === 0 ? 'pending-approval' : 'none',
        paidDate: null,
        ...(index > 0 ? { dueDate: new Date(Date.now() + (index * 30 * 24 * 60 * 60 * 1000)) } : {})
      }));
    }

    if (isWebsiteService) {
      orderData.projectProgress = 0;
      orderData.messages = [];
    }

    if (isWebsiteUpdate) {
      orderData.updatesUsed = 0;
      orderData.isActive = true;

      // Special handling for yearly renewable plans
      if (isYearlyRenewablePlan) {
        const currentDate = new Date();
        const monthExpiryDate = new Date(currentDate);
        monthExpiryDate.setDate(monthExpiryDate.getDate() + 30); // First month starts immediately

        orderData.totalYearlyDaysRemaining = product.yearlyPlanDuration || 365;
        orderData.currentMonthExpiryDate = monthExpiryDate;
        orderData.autoRenewalStatus = 'active';
        orderData.currentMonthUpdatesUsed = 0;

        // Initialize first renewal period in history
        orderData.monthlyRenewalHistory = [{
          renewalDate: currentDate,
          renewalCost: price, // Initial purchase amount
          paymentStatus: 'paid',
          renewalPeriodStart: currentDate,
          renewalPeriodEnd: monthExpiryDate,
          updatesUsedInPeriod: 0
        }];

        console.log('Yearly renewable plan initialized with:', {
          totalYearlyDaysRemaining: orderData.totalYearlyDaysRemaining,
          currentMonthExpiryDate: orderData.currentMonthExpiryDate,
          firstRenewalPeriod: orderData.monthlyRenewalHistory[0]
        });
      }

      // Special handling for monthly limited plans (new feature)
      if (product.isMonthlyLimitedPlan) {
        const currentDate = new Date();
        const monthExpiryDate = new Date(currentDate);
        monthExpiryDate.setDate(monthExpiryDate.getDate() + 30); // First month starts immediately

        orderData.totalYearlyDaysRemaining = product.yearlyPlanDuration || 365;
        orderData.currentMonthExpiryDate = monthExpiryDate;
        orderData.autoRenewalStatus = 'active';
        orderData.currentMonthUpdatesUsed = 0;

        // Set monthly update limits
        orderData.currentMonthUpdatesLimit = product.monthlyUpdateLimit || 1;
        orderData.currentMonthUpdatesRemaining = product.monthlyUpdateLimit || 1;
        orderData.monthlyLimitResetDate = monthExpiryDate;

        // Initialize first renewal period in history
        orderData.monthlyRenewalHistory = [{
          renewalDate: currentDate,
          renewalCost: price, // Initial purchase amount
          paymentStatus: 'paid',
          renewalPeriodStart: currentDate,
          renewalPeriodEnd: monthExpiryDate,
          updatesUsedInPeriod: 0
        }];

        console.log('Monthly limited plan initialized with:', {
          totalYearlyDaysRemaining: orderData.totalYearlyDaysRemaining,
          currentMonthExpiryDate: orderData.currentMonthExpiryDate,
          monthlyUpdateLimit: orderData.currentMonthUpdatesLimit,
          monthlyLimitResetDate: orderData.monthlyLimitResetDate,
          firstRenewalPeriod: orderData.monthlyRenewalHistory[0]
        });
      }
    }

    const order = new orderProductModel(orderData);

    if (isWebsiteService) {
      const categoryBasePrice = await categoryBasePriceModel.findOne({ category: product.category }).lean();
      const startingNodeTitle = categoryBasePrice?.startingNodeTitle?.trim() || DEFAULT_STARTING_NODE_TITLE;
      initializeProjectTimeline({ order, startingNodeTitle, actorId: userId });
    }

    await order.save();

    // SSOT invoice creation — only for website/software PROJECT orders (not plans/updates,
    // which use the separate monthlyInvoiceModel/renewal system). Every project order gets
    // an unpaid invoice so "invoice pending" and "project pending" always exist together;
    // the customer pays via /invoice-detail/:invoiceId (canonical Pay Now) and admin approval
    // marks it paid through the shared markProjectInvoicePaid() helper. Order stays
    // pending-approval until then (Q2).
    if (isWebsiteService) {
      try {
        const invoiceLineItems = (order.orderItems || []).map((item) => ({
          name: item.name,
          price: Number(item.finalPrice ?? item.originalPrice ?? 0),
        }));
        const projectInvoiceDate = new Date();
        if (order.isPartialPayment && Array.isArray(order.installments) && order.installments.length > 0) {
          // Only the currently due first installment is invoiced at creation.
          // Later installments are created by settleInstallmentInvoice exactly when
          // their payment is due/settled, matching every other project path.
          const installment = order.installments[0];
          await createProjectInvoice({
            customerId: userId,
            orderId: order._id,
            amount: installment.amount,
            lineItems: invoiceLineItems,
            installmentNumber: installment.installmentNumber,
            invoiceDate: projectInvoiceDate,
            dueDate: installment.dueDate || projectInvoiceDate,
          });
        } else {
          await createProjectInvoice({
            customerId: userId,
            orderId: order._id,
            amount: Number(order.totalAmount || order.price || 0),
            lineItems: invoiceLineItems,
            invoiceDate: projectInvoiceDate,
          });
        }
      } catch (invoiceError) {
        // Invoice creation must never hard-fail checkout — the order is already saved.
        console.error("Project invoice creation failed (order still created):", invoiceError);
      }
    }

    // Fetch the saved order with populated fields
    const populatedOrder = await orderProductModel.findById(order._id)
      .populate('userId', 'name email')
      .populate('productId', 'serviceName category totalPages validityPeriod updateCount isWebsiteUpdate isMonthlyLimitedPlan monthlyUpdateLimit monthlyRenewalPrice');

    // Every order here is pending until an admin approves its payment, so only the admin is notified.
    try {
      await sendAdminUPIPendingNotification(populatedOrder);
      console.log('Admin pending approval notification sent for order:', order._id);
    } catch (emailError) {
      console.error('Error sending admin pending notification:', emailError);
    }

    res.status(201).json({
      message: "Order created successfully",
      success: true,
      data: populatedOrder
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({
      message: error.message,
      success: false
    });
  }
};

module.exports = createOrder;
