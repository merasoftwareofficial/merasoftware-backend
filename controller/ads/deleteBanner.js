const uploadBannerPermission = require("../../helpers/permission");
const bannerModel = require("../../models/bannerModel");

async function DeleteBannerController(req, res) {
    try {
        const sessionUserId = req.userId;
        
        // Check permissions
        if (!(await uploadBannerPermission(sessionUserId))) {
            return res.status(403).json({
                message: "Permission denied",
                error: true,
                success: false
            });
        }

        const { _id } = req.body;

        if (!_id) {
            return res.status(400).json({
                message: "Banner ID is required",
                error: true,
                success: false
            });
        }

        // Find and delete the banner
        const deletedBanner = await bannerModel.findByIdAndDelete(_id);

        if (!deletedBanner) {
            return res.status(404).json({
                message: "Banner not found",
                error: true,
                success: false
            });
        }

        return res.status(200).json({
            message: "Banner deleted successfully",
            error: false,
            success: true,
            data: deletedBanner
        });

    } catch (err) {
        console.error("Delete banner error:", err);
        return res.status(400).json({
            message: err.message || "Error deleting banner",
            error: true,
            success: false
        });
    }
}

module.exports = DeleteBannerController;