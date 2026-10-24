const userModel = require("../../models/userModel");
const transactionModel = require("../../models/transactionModel");
const mongoose = require("mongoose");
const { prepareUpiPaymentEvidence } = require("../../helpers/upiPaymentEvidence");

const verifyPaymentController = async (req, res) => {
    try {
        const {
            transactionId,
            amount,
            upiTransactionId,
            isInstallmentPayment,
            orderId,
            invoiceId,
            installmentNumber,
            type,
            description,
            isPartialInstallmentPayment = false ,
            paymentMethod,
            sourceType
        } = req.body;
        
        // Validate required fields
        if (!transactionId || !amount) {
            throw new Error("Transaction ID and Amount are required");
          }
          
          const resolvedPaymentMethod = paymentMethod || 'upi';
          const paymentEvidence = resolvedPaymentMethod === 'upi'
            ? await prepareUpiPaymentEvidence({ reference: upiTransactionId, transactionId, capturedVia: 'customer' })
            : null;
        
        // Check if transaction already exists
        const existingTransaction = await transactionModel.findOne({ transactionId });
        if (existingTransaction) {
            return res.status(200).json({
                message: "Transaction already submitted and pending admin verification",
                data: {
                    transactionId,
                    status: existingTransaction.status
                },
                success: true,
                error: false
            });
        }
        
        // Process order ID
        let processedOrderId = null;
        if (orderId) {
            try {
                if (mongoose.Types.ObjectId.isValid(orderId)) {
                    processedOrderId = new mongoose.Types.ObjectId(orderId);
                } else {
                    processedOrderId = orderId;
                }
            } catch (error) {
                console.error("Error converting orderId:", error);
                processedOrderId = String(orderId);
            }
        }

        let processedInvoiceId = null;
        if (invoiceId) {
            try {
                if (mongoose.Types.ObjectId.isValid(invoiceId)) {
                    processedInvoiceId = new mongoose.Types.ObjectId(invoiceId);
                } else {
                    processedInvoiceId = invoiceId;
                }
            } catch (error) {
                console.error("Error converting invoiceId:", error);
                processedInvoiceId = String(invoiceId);
            }
        }

        // A project payment submitted after a reservation deadline meets the current price first.
        const priceOrderId = processedOrderId || (mongoose.isValidObjectId(processedInvoiceId)
            ? (await require('../../models/invoiceModel').findById(processedInvoiceId).select('orderId').lean())?.orderId : null);
        if (priceOrderId) await require('../../helpers/reservationRepricing').ensureReservationPriceCurrent(priceOrderId);

        // Determine transaction type
        const transactionType = type || (isInstallmentPayment ? "payment" : "deposit");
        
        // Create transaction description
        const transactionDescription = description ||
            (isInstallmentPayment
                ? `Installment ${installmentNumber || 1} payment for order #${processedOrderId || 'unknown'}`
                : 'Wallet recharge via UPI');
        
                // Explicitly identify wallet recharges (no orderId means it's a wallet recharge)
        const isWalletRecharge = !isInstallmentPayment && !orderId;
        const resolvedSourceType =
            sourceType ||
            (processedInvoiceId ? "invoice" : null) ||
            (isWalletRecharge ? "wallet" : null) ||
            (installmentNumber ? "installment" : "order");

        // Get the referredBy field from the user model
        const user = await userModel.findById(req.userId);
        const referredBy = user ? user.referredBy : null; // Get the referrer ID

        // Create transaction record
        const transaction = new transactionModel({
            userId: req.userId,
            transactionId: transactionId,
            amount: Number(amount),
            upiTransactionId: upiTransactionId,
            // Use 'deposit' type ONLY for wallet recharges
            type: isWalletRecharge ? 'deposit' : 'payment',
            description: isWalletRecharge
                ? 'Wallet recharge via UPI'
                : (transactionDescription || `Payment for order #${processedOrderId || 'unknown'}`),
            status: 'pending',
            // For all payments, use 'pending-approval' (valid enum value)
            // For wallet recharge without order, use null (allowed by default)
            paymentStatus: isWalletRecharge ? null : 'pending-approval',
            paymentMethod: resolvedPaymentMethod,
            paymentEvidence,
            sourceType: resolvedSourceType,
            date: new Date(),
            // Mark as installment payment for order payments
            isInstallmentPayment: !!isInstallmentPayment || !!orderId,
            orderId: processedOrderId,
            invoiceId: processedInvoiceId,
            installmentNumber: installmentNumber ? Number(installmentNumber) : null,
            // Add this flag to indicate it's a partial payment
            isPartialInstallmentPayment: isPartialInstallmentPayment,
            isPartialWalletPayment: isPartialInstallmentPayment,
            referredBy: referredBy
        });
        
        // Save transaction
        await transaction.save();
        
        console.log(`New transaction created: ${transaction._id}, Type: ${transactionType}, IsInstallment: ${!!isInstallmentPayment}`);
        
        res.status(200).json({
            message: isInstallmentPayment
                ? "Installment payment verification submitted. It will be processed after admin approval."
                : "Payment verification submitted. Your wallet will be updated after admin approval.",
            data: {
                transactionId,
                status: 'pending'
            },
            success: true,
            error: false
        });
    } catch (err) {
        console.error("Error in verifyPaymentController:", err);
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        });
    }
};

module.exports = verifyPaymentController;
