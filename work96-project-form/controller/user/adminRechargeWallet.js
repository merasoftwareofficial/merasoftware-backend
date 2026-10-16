const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const { creditWalletInstant } = require("../../helpers/transactionService");

// Admin-initiated wallet recharge for a client — instant credit, no approval step.
//
// This is the admin twin of the customer's own recharge (WalletDetails.js -> verify-payment,
// which creates a PENDING deposit the admin later approves). Here the admin is recording money
// already collected (cash/UPI/bank), so it is credited immediately via creditWalletInstant():
// a 'completed' deposit transaction + an atomic balance credit — SSOT-safe, and it shows up in
// the client's own wallet history like any other recharge. No parallel store, no direct set.

const PAYMENT_METHODS = ["upi", "cash", "bank_transfer", "wallet"];

const requireAdmin = async (req, res) => {
  const adminUser = await userModel.findById(req.userId).select("roles");
  if (req.userRole !== "admin" || !adminUser?.roles?.includes("admin")) {
    res.status(403).json({ message: "Forbidden", error: true, success: false });
    return false;
  }
  return true;
};

const adminRechargeWallet = async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;

    const { customerId } = req.params;
    if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({
        message: "Valid customerId is required",
        error: true,
        success: false,
      });
    }

    const { amount, paymentMethod = "upi", reference, note } = req.body;

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        message: "A positive amount is required",
        error: true,
        success: false,
      });
    }

    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ message: "Valid payment method is required", error: true, success: false });
    }
    const method = paymentMethod;

    const customer = await userModel.findById(customerId).select("_id name");
    if (!customer) {
      return res.status(404).json({
        message: "Customer not found",
        error: true,
        success: false,
      });
    }

    const transactionId = `ADMINRC${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const description = note?.trim()
      ? `Admin wallet recharge — ${note.trim()}`
      : "Admin wallet recharge";

    const { transaction, newBalance } = await creditWalletInstant({
      userId: customerId,
      transactionId,
      amount: numericAmount,
      paymentMethod: method,
      reference: reference?.trim() || null,
      description,
      actorId: req.userId,
    });

    return res.status(201).json({
      message: "Wallet recharged successfully",
      success: true,
      error: false,
      data: {
        transactionId: transaction.transactionId,
        amount: numericAmount,
        walletBalance: newBalance,
      },
    });
  } catch (error) {
    console.error("Error recharging wallet:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to recharge wallet",
      error: true,
      success: false,
    });
  }
};

module.exports = adminRechargeWallet;
