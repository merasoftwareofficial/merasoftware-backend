const uploadPermission = require("../../helpers/permission")
const UserWelcome = require("../../models/userWelcomeModal")

async function updateUserWelcomeController(req, res) {
    try {
        const sessionUserId = req.userId
        const { id } = req.params

        if(!(await uploadPermission(sessionUserId))){
            throw new Error("Permission denied")
        }

        // Find the welcome content by ID
        const existingWelcome = await UserWelcome.findById(id)
        if (!existingWelcome) {
            return res.status(404).json({
                message: "User Welcome content not found",
                error: true,
                success: false
            })
        }

        // If the updated content should be active, deactivate all others
        if (req.body.isActive) {
            await UserWelcome.updateMany(
                { _id: { $ne: id } },
                { isActive: false }
            )
        }

        // Update the welcome content
        const updatedContent = await UserWelcome.findByIdAndUpdate(
            id,
            req.body,
            { new: true }
        )
       
        res.status(200).json({
            message: "User Welcome Updated Successfully",
            error: false,
            success: true,
            data: updatedContent
        })
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        })
    }
}

module.exports = updateUserWelcomeController