const uploadPermission = require("../../helpers/permission")
const UserWelcome = require("../../models/userWelcomeModal")

async function uploadUserWelcomeController(req, res) {
    try {
        const sessionUserId = req.userId
        if(!(await uploadPermission(sessionUserId))){
            throw new Error("Permission denied")
        }

        if (req.body.isActive) {
            await UserWelcome.updateMany(
                { _id: { $ne: null } },
                { isActive: false }
            )
        }

        const userWelcome = new UserWelcome(req.body)
        const savedContent = await userWelcome.save()
       
        res.status(201).json({
            message: "User Welcome Created Successfully",
            error: false,
            success: true,
            data: savedContent
        })
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        })
    }
}

module.exports = uploadUserWelcomeController