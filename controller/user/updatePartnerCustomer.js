const userModel = require("../../models/userModel");
const mongoose = require("mongoose");
const { syncClientLeads } = require("../../helpers/wonLead");

async function updatePartnerCustomer(req, res) {
    try {
        const partnerId = req.userId; // Auth middleware se partner ID
        const customerId = req.params.customerId; // URL parameter se customer ID
        const { name, email, phone } = req.body; // Update karne wale fields

        // Validate required fields
        if (!customerId) {
            return res.status(400).json({
                success: false,
                message: "Customer ID is required"
            });
        }

        if (!name && !email && !phone) {
            return res.status(400).json({
                success: false,
                message: "At least one field (name, email, phone) is required to update"
            });
        }

        // Check if customer exists and is referred by this partner
        const customer = await userModel.findOne({
            _id: customerId,
            referredBy: partnerId
        });

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found or you don't have permission to update this customer"
            });
        }

        // Prepare update object
        const updateData = {};
        if (name) updateData.name = name;
        if (email) {
            // Check if email already exists for another user
            const existingUser = await userModel.findOne({
                email: email,
                _id: { $ne: customerId }
            });
            
            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    message: "Email already exists for another user"
                });
            }
            updateData.email = email;
        }
        if (phone) updateData.phone = phone;

        // Update customer details
        // A client's Won lead keeps the same name, phone and email as the account: both change together.
        let updatedCustomer;
        await mongoose.connection.transaction(async (session) => {
            updatedCustomer = await userModel.findByIdAndUpdate(
                customerId,
                updateData,
                {
                    new: true, // Return updated document
                    runValidators: true, // Run schema validations
                    session
                }
            ).select('name email phone createdAt walletBalance');
            await syncClientLeads(updatedCustomer, { session });
        });

        res.json({
            success: true,
            message: "Customer details updated successfully",
            data: updatedCustomer
        });

    } catch (error) {
        console.error("Error updating customer details:", error);
        
        // Handle duplicate email error
        if (error.code === 11000 && error.keyPattern?.email) {
            return res.status(400).json({
                success: false,
                message: "Email already exists"
            });
        }

        res.status(500).json({
            success: false,
            message: "Failed to update customer details",
            error: error.message
        });
    }
}

module.exports = updatePartnerCustomer;