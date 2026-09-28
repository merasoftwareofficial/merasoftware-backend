const uploadPermission = require("../../helpers/permission")
const UserWelcome = require("../../models/userWelcomeModal")

async function deleteUserWelcomeController(req, res) {
    try {
        const sessionUserId = req.userId
        const { id } = req.params

        if(!(await uploadPermission(sessionUserId))){
            throw new Error("Permission denied")
        }

        // Find and delete the welcome content
        const deletedContent = await UserWelcome.findByIdAndDelete(id)
        
        if (!deletedContent) {
            return res.status(404).json({
                message: "User Welcome content not found",
                error: true,
                success: false
            })
        }
       
        res.status(200).json({
            message: "User Welcome Deleted Successfully",
            error: false,
            success: true
        })
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        })
    }
}

module.exports = deleteUserWelcomeController