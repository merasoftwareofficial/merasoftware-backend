const mongoose = require("mongoose");
const userModel = require("../../models/userModel");
const { syncClientLeads } = require("../../helpers/wonLead");

async function updateUserProfileController(req, res) {
    try {
        const userId = req.userId;  
        const { name, phone, age, profilePic } = req.body;

        // Update data object
        const updateData = {
            name,
            phone,
            age
        };

        // अगर profilePic आया है तो उसे भी add करें
        if (profilePic) {
            updateData.profilePic = profilePic;
        }

        // A client's Won lead keeps the same name and phone as the account: both change together.
        let updatedUser;
        await mongoose.connection.transaction(async (session) => {
            updatedUser = await userModel.findByIdAndUpdate(
                userId,
                updateData,
                { new: true, session }
            ).select('-password');

            if (!updatedUser) {
                throw new Error("User not found");
            }

            await syncClientLeads(updatedUser, { session });
        });

        res.status(200).json({
            data: {
                ...updatedUser._doc,
                role: req.userRole
            },
            error: false,
            success: true,
            message: "Profile updated successfully"
        });

    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        });
    }
}

module.exports = updateUserProfileController;
