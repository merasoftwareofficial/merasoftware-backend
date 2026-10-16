const cron = require('node-cron');
const orderProductModel = require('../models/orderProductModel');
const monthlyInvoiceModel = require('../models/monthlyInvoiceModel');
const userModel = require('../models/userModel');
const {
    sendMonthlyInvoiceEmail,
    sendAdminAutoRenewalNotification,
    generateMonthlyInvoicePdf
} = require('../helpers/emailService');
const { updateOverdueInvoicesAndPausePlans } = require('../helpers/invoiceLifecycle');

// Generate unique invoice number
const generateInvoiceNumber = async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `INV-${year}${month}`;

    // Find the last invoice for this month
    const lastInvoice = await monthlyInvoiceModel
        .findOne({ invoiceNumber: new RegExp(`^${prefix}`) })
        .sort({ invoiceNumber: -1 });

    let sequenceNumber = 1;
    if (lastInvoice) {
        const lastSequence = parseInt(lastInvoice.invoiceNumber.split('-')[2]);
        sequenceNumber = lastSequence + 1;
    }

    return `${prefix}-${String(sequenceNumber).padStart(4, '0')}`;
};

// Auto-renewal function
const processAutoRenewal = async () => {
    try {
        console.log('🔄 Running auto-renewal cron job at:', new Date().toISOString());

        const overdueResult = await updateOverdueInvoicesAndPausePlans();
        console.log(`⏸️ Marked ${overdueResult.processed} overdue invoice(s) and paused related plans`);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Find all monthly limited plans due through today, including missed cron runs.
        const duePlans = await orderProductModel.find({
            currentMonthExpiryDate: {
                $lt: tomorrow
            },
            totalYearlyDaysRemaining: { $gt: 0 }
        }).populate('productId').populate('userId');

        // Filter for monthly limited plans (after populate)
        const monthlyLimitedPlans = duePlans.filter(plan =>
            plan.productId && plan.productId.isMonthlyLimitedPlan === true
        );

        console.log(`📊 Found ${duePlans.length} plans due for renewal through today`);
        console.log(`🟣 Found ${monthlyLimitedPlans.length} monthly limited plans to renew`);

        for (const plan of monthlyLimitedPlans) {
            try {
                console.log(`🔄 Processing renewal for order: ${plan._id}`);

                // Check if plan is closed
                if (plan.planStatus === 'closed') {
                    console.log(`⚠️ Plan ${plan._id} is closed. Skipping renewal.`);
                    continue;
                }

                // Check if plan has enough remaining days
                if (plan.totalYearlyDaysRemaining <= 0) {
                    console.log(`⚠️ Plan ${plan._id} has no remaining days. Skipping.`);
                    continue;
                }

                // Calculate days to deduct (30 or remaining days if less than 30)
                const daysToDeduct = Math.min(30, plan.totalYearlyDaysRemaining);

                // Calculate new dates
                const renewalStartDate = new Date(plan.currentMonthExpiryDate);
                const renewalEndDate = new Date(renewalStartDate);
                renewalEndDate.setDate(renewalEndDate.getDate() + daysToDeduct);

                const existingInvoice = await monthlyInvoiceModel.findOne({
                    orderId: plan._id,
                    renewalPeriodStart: renewalStartDate,
                    renewalPeriodEnd: renewalEndDate
                });

                // Update plan with new renewal period
                plan.currentMonthUpdatesUsed = 0;
                plan.currentMonthUpdatesRemaining = plan.productId.monthlyUpdateLimit || 1;
                plan.currentMonthUpdatesLimit = plan.productId.monthlyUpdateLimit || 1;
                plan.currentMonthExpiryDate = renewalEndDate;
                plan.monthlyLimitResetDate = renewalEndDate;
                plan.totalYearlyDaysRemaining -= daysToDeduct;

                // Calculate renewal month number
                const totalYearlyDays = plan.productId.yearlyPlanDuration || 365;
                const daysCompleted = totalYearlyDays - plan.totalYearlyDaysRemaining;
                const renewalMonth = Math.floor(daysCompleted / 30) + 1;

                await plan.save();
                console.log(`✅ Plan ${plan._id} renewed. Days remaining: ${plan.totalYearlyDaysRemaining}`);

                if (existingInvoice) {
                    console.log(`ℹ️ Invoice already exists for order ${plan._id} and period ${renewalStartDate.toISOString()} - ${renewalEndDate.toISOString()}. Skipping duplicate invoice.`);
                    continue;
                }

                // Generate invoice number
                const invoiceNumber = await generateInvoiceNumber();

                // Calculate due date (7 days from invoice date)
                const invoiceDate = new Date();
                const dueDate = new Date(invoiceDate);
                dueDate.setDate(dueDate.getDate() + 7);

                // Create invoice record
                const invoice = new monthlyInvoiceModel({
                    userId: plan.userId._id,
                    orderId: plan._id,
                    invoiceNumber: invoiceNumber,
                    amount: plan.productId.monthlyRenewalPrice || 3000,
                    status: 'unpaid',
                    invoiceDate: invoiceDate,
                    dueDate: dueDate,
                    renewalMonth: renewalMonth,
                    renewalPeriodStart: renewalStartDate,
                    renewalPeriodEnd: renewalEndDate
                });

                await invoice.save();
                console.log(`📄 Invoice ${invoiceNumber} created for order ${plan._id}`);

                // Generate PDF invoice
                const invoicePdfBuffer = await generateMonthlyInvoicePdf(
                    plan.userId,
                    plan,
                    invoice
                );

                // Send invoice email to user
                await sendMonthlyInvoiceEmail(
                    plan.userId,
                    plan,
                    invoice,
                    invoicePdfBuffer
                );
                console.log(`📧 Invoice email sent to user: ${plan.userId.email}`);

                // Send notification to admin
                await sendAdminAutoRenewalNotification(
                    plan.userId,
                    plan,
                    invoice
                );
                console.log(`📧 Admin notification sent for order: ${plan._id}`);

            } catch (planError) {
                console.error(`❌ Error processing plan ${plan._id}:`, planError);
                // Continue with next plan even if one fails
                continue;
            }
        }

        console.log('✅ Auto-renewal cron job completed successfully');

    } catch (error) {
        console.error('❌ Error in auto-renewal cron job:', error);
    }
};

// Schedule cron job to run daily at 1:00 AM
const scheduleAutoRenewal = () => {
    // Run daily at 1:00 AM
    cron.schedule('0 1 * * *', processAutoRenewal, {
        timezone: 'Asia/Kolkata'
    });

    console.log('⏰ Auto-renewal cron job scheduled - runs daily at 1:00 AM IST');
};

module.exports = {
    scheduleAutoRenewal,
    processAutoRenewal // Export for manual testing
};
