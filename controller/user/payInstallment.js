const Order = require('../../models/orderProductModel');
const Transaction = require('../../models/transactionModel');
const User = require('../../models/userModel'); // Add this import if needed

const payInstallment = async (req, res) => {
    const { 
      orderId, 
      installmentNumber, 
      amount, 
      isInstallmentPayment = false,
      transactionId = null,
      paymentStatus = 'paid', // New parameter: 'paid' or 'pending-approval'
      upiTransactionId = null, // For QR code payments
      isAdminApproval = false
    } = req.body;
    
    const userId = req.userId;
    const isAdmin = req.userRole === 'admin' || isAdminApproval; // Assuming role is available in the request
 
    // Validate input
    if (!orderId || !installmentNumber || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }
 
    try {
      // A submission after a reservation deadline meets the current price before the order is read.
      await require('../../helpers/reservationRepricing').ensureReservationPriceCurrent(orderId);
      // Find the order - if admin is making the request, don't filter by userId
      const orderQuery = isAdmin 
        ? { _id: orderId, isPartialPayment: true }
        : { _id: orderId, userId: userId, isPartialPayment: true };
        
      const order = await Order.findOne(orderQuery);
 
      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found or not a partial payment order'
        });
      }

      // Find the specific installment
      const installmentIndex = order.installments.findIndex(
        inst => inst.installmentNumber === parseInt(installmentNumber)
      );
 
      if (installmentIndex === -1) {
        return res.status(404).json({
          success: false,
          message: 'Installment not found'
        });
      }
 
      const installment = order.installments[installmentIndex];
 
      // Check if installment is already paid
      if (installment.paid && paymentStatus === 'paid') {
        return res.status(400).json({
          success: false,
          message: 'This installment has already been paid'
        });
      }
 
      // Verify amount matches the installment amount (with some flexibility for admin)
      if (!isAdmin && !isAdminApproval && installment.amount !== amount) {
        return res.status(400).json({
          success: false,
          message: 'Amount does not match installment amount'
        });
      }
      
      // Record transaction if it's a new payment
      if (transactionId && paymentStatus === 'pending-approval') {
         // Add this new check for existing transactions
  const existingTx = await Transaction.findOne({ transactionId });
  if (existingTx) {
    // Just update the installment status without creating a new transaction
    order.installments[installmentIndex].paymentStatus = 'pending-approval';
    await order.save();
    
    return res.status(200).json({
      success: true,
      message: `Installment ${installmentNumber} payment already submitted for verification`,
      data: {
        orderId: order._id,
        installmentNumber: installmentNumber,
        status: 'pending-approval'
      }
    });
  }
        // Create or update transaction record for this payment
        let transactionData = {
          userId: order.userId,
          amount: amount,
          status: 'pending',
          paymentStatus: 'pending-approval',
          description: `Installment #${installmentNumber} for order #${orderId}`,
          transactionId: transactionId,
          isInstallmentPayment: true,
          installmentNumber: parseInt(installmentNumber),
          orderId: orderId,
          type: 'payment',
          sourceType: 'installment'
        };
        
        if (upiTransactionId) {
          transactionData.upiTransactionId = upiTransactionId;
        }
        
        await Transaction.create(transactionData);
        
        // Update installment status to pending but don't mark as paid yet
        order.installments[installmentIndex].paymentStatus = 'pending-approval';
        
        await order.save();
        
        return res.status(200).json({
          success: true,
          message: `Installment ${installmentNumber} payment submitted for verification`,
          data: {
            orderId: order._id,
            installmentNumber: installmentNumber,
            status: 'pending-approval'
          }
        });
      }
      
      // REMOVED (partial-payment SSOT correction): this branch used to mark an installment
      // `paid` directly from a client-trusted `paymentStatus:'paid'` flag (or a bare `isAdmin`
      // check) — no transaction was created and no invoice was ever touched, so an installment
      // could be "paid" with zero payment evidence behind it (doc 52 Phase 7's audit found real
      // DB proof of exactly this: invoices marked paid with zero completed transactions).
      // Verified before removing: the only live caller, InstallmentPayment.js, never sends
      // paymentStatus:'paid' (it only reaches this endpoint via the pending-approval branch
      // above); no admin UI calls this route either. The SSOT-safe replacements for settling an
      // installment are POST /api/wallet/pay-instant (walletPayInstant.js) for instant wallet
      // payment, and admin transaction approval (transactionApprovalController.js) for UPI —
      // both settle the order AND its invoice through the shared settleInstallmentInvoice()
      // helper (helpers/installmentSettlement.js). This endpoint no longer marks anything paid.
      return res.status(400).json({
        success: false,
        message: 'Invalid payment status'
      });
    } catch (error) {
      console.error('Error in payInstallment:', error);
      return res.status(500).json({
        success: false,
        message: 'Error processing payment',
        error: error.message
      });
    }
  };
  
module.exports = payInstallment;
