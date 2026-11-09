const orderProductModel = require("../../models/orderProductModel")
const invoiceModel = require("../../models/invoiceModel");
const mongoose = require('mongoose');
const { applyOrderSummary, ORDER_SUMMARY_FIELDS, attachOrderState } = require("../../helpers/orderSummary");
const { getDueUnpaidInvoiceFilter, dueInstallment } = require("../../helpers/projectDuePayment");

const getUserOrders = async (req, res) => {
    try {
        // Get the current user's ID from req.userId (which should be set by your auth middleware)
        const userId = req.userId;

        // Convert userId string to MongoDB ObjectId for proper matching
        let userObjectId;
        try {
            userObjectId = mongoose.Types.ObjectId(userId);
        } catch (e) {
            userObjectId = userId; // Fallback if already ObjectId
        }

        // Add userId filter to only get orders for the current user
        // `installments`/`currentInstallment` are added on top of the shared
        // ORDER_SUMMARY_FIELDS (select() is additive) so this controller alone gets what it
        // needs for the due-installment check below, without changing the payload for
        // ORDER_SUMMARY_FIELDS's other callers (getAdminUserWorkspace.js, getMyPaymentWorkspace.js).
        const orders = await applyOrderSummary(
            orderProductModel
                .find({ userId: userObjectId })
                .sort({ createdAt: -1 })
                .select("installments currentInstallment")
        );

        // Flag project orders whose currently-due installment invoice is unpaid/overdue, so the
        // list's status badge shows "Payment Pending" only when a payment is actually actionable
        // right now — matches getOrderDetails.js's single-order rule (helpers/projectDuePayment.js).
        // A future installment's invoice legitimately stays 'unpaid' until its own
        // progressThreshold is reached; that is not "payment pending" for the customer today.
        // Plan orders (monthlyInvoiceModel-based) never have installments and fall through
        // getDueUnpaidInvoiceFilter's plain orderId+status match unchanged.
        const projectOrders = orders.filter((order) => order.isWebsiteProject);
        const unpaidInvoices = projectOrders.length
            ? await invoiceModel
                .find({ $or: projectOrders.map((order) => getDueUnpaidInvoiceFilter(order)) })
                .select('orderId')
                .lean()
            : [];
        const unpaidOrderIds = new Set(unpaidInvoices.map((invoice) => String(invoice.orderId)));
        orders.forEach((order) => {
            // A due, unpaid installment counts even before its invoice exists (projectDuePayment.js).
            order.hasUnpaidInvoice = unpaidOrderIds.has(String(order._id)) || (order.isWebsiteProject && Boolean(dueInstallment(order)));
            // applyOrderSummary already attached orderState, but it ran before hasUnpaidInvoice
            // existed — and "Payment Pending" is derived from that flag. Recompute now that the
            // real value is known, so the badge this endpoint feeds is not one state behind.
            attachOrderState(order);
        });

        console.log('Total projects found:', orders.length);
        console.log('Sample project:', orders[0]);

        // Debug yearly plans (renewable & limited)
        const yearlyPlans = orders.filter(order =>
            order.productId?.isMonthlyRenewablePlan || order.productId?.isMonthlyLimitedPlan
        );
        if (yearlyPlans.length > 0) {
            console.log('Found yearly plans:', yearlyPlans.length);
            console.log('Yearly plan sample:', {
                id: yearlyPlans[0]._id,
                isMonthlyRenewablePlan: yearlyPlans[0].productId?.isMonthlyRenewablePlan,
                isMonthlyLimitedPlan: yearlyPlans[0].productId?.isMonthlyLimitedPlan,
                yearlyPlanDuration: yearlyPlans[0].productId?.yearlyPlanDuration,
                monthlyRenewalCost: yearlyPlans[0].productId?.monthlyRenewalCost,
                monthlyUpdateLimit: yearlyPlans[0].productId?.monthlyUpdateLimit,
                monthlyRenewalPrice: yearlyPlans[0].productId?.monthlyRenewalPrice,
                totalYearlyDaysRemaining: yearlyPlans[0].totalYearlyDaysRemaining,
                currentMonthExpiryDate: yearlyPlans[0].currentMonthExpiryDate,
                currentMonthUpdatesUsed: yearlyPlans[0].currentMonthUpdatesUsed,
                currentMonthUpdatesLimit: yearlyPlans[0].currentMonthUpdatesLimit,
                currentMonthUpdatesRemaining: yearlyPlans[0].currentMonthUpdatesRemaining
            });
        }
        
        res.status(200).json({
            success: true,
            data: orders
        });
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

module.exports = getUserOrders
