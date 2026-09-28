const uploadPermission = require("../../helpers/permission")
const GuestSlides = require("../../models/guestSlidesModal")

async function deleteGuestSlidesController(req, res) {
    try {
        const sessionUserId = req.userId
        const { id } = req.params

        if(!(await uploadPermission(sessionUserId))){
            throw new Error("Permission denied")
        }

        // Find and delete the slide
        const deletedSlide = await GuestSlides.findByIdAndDelete(id)
        
        if (!deletedSlide) {
            return res.status(404).json({
                message: "Guest slide not found",
                error: true,
                success: false
            })
        }
       
        res.status(200).json({
            message: "Guest Slide Deleted Successfully",
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

module.exports = deleteGuestSlidesController