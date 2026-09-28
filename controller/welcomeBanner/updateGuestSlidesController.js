const uploadPermission = require("../../helpers/permission")
const GuestSlides = require("../../models/guestSlidesModal")

async function updateGuestSlidesController(req, res) {
    try {
        const sessionUserId = req.userId
        const slideId = req.params.id

        if(!(await uploadPermission(sessionUserId))){
            throw new Error("Permission denied")
        }

        // If setting this slide as active, deactivate all others
        // if (req.body.isActive) {
        //     await GuestSlides.updateMany(
        //         { _id: { $ne: slideId } },
        //         { isActive: false }
        //     )
        // }

        const updatedSlide = await GuestSlides.findByIdAndUpdate(
            slideId,
            req.body,
            { new: true }
        )

        if (!updatedSlide) {
            throw new Error("Guest slide not found")
        }
       
        res.status(200).json({
            message: "Guest Slide Updated Successfully",
            error: false,
            success: true,
            data: updatedSlide
        })
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        })
    }
}

module.exports = updateGuestSlidesController