const uploadPermission = require("../../helpers/permission")
const GuestSlides = require("../../models/guestSlidesModal")

async function uploadGuestSlidesController(req, res) {
    try {
        const sessionUserId = req.userId
        if(!(await uploadPermission(sessionUserId))){
            throw new Error("Permission denied")
        }

        // if (req.body.isActive) {
        //     await GuestSlides.updateMany(
        //         { _id: { $ne: null } },
        //         { isActive: false }
        //     )
        // }

        const guestSlides = new GuestSlides(req.body)
        const savedContent = await guestSlides.save()
       
        res.status(201).json({
            message: "Guest Slides Created Successfully",
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

module.exports = uploadGuestSlidesController