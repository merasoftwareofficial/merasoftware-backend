const uploadProductPermission = require("../../helpers/permission")
const bannerModel = require("../../models/bannerModel")

async function updateBannerController(req, res) {
    try {
        // Check permission
        if (!(await uploadProductPermission(req.userId))) {
            throw new Error("Permission denied")
        }

        // Extract _id and rest of the body
        const { _id, ...updateData } = req.body

        // Validate required fields
        if (!updateData.serviceName) {
            throw new Error("Service name is required")
        }
        if (!updateData.position) {
            throw new Error("Position is required")
        }
        if (typeof updateData.displayOrder !== 'number') {
            throw new Error("Display order must be a number")
        }

        if (updateData.targetUrl) {
            try {
                new URL(updateData.targetUrl);
            } catch (e) {
                throw new Error("Invalid URL format");
            }
        }

        // Check for existing banner with same position and display order
        const existingBanner = await bannerModel.findOne({
            position: updateData.position,
            displayOrder: updateData.displayOrder,
            _id: { $ne: _id }  // Exclude current banner
        });

        if (existingBanner) {
            throw new Error(`Banner with display order ${updateData.displayOrder} already exists for this position`);
        }

        // Update banner
        const updatedBanner = await bannerModel.findByIdAndUpdate(
            _id,
            {
                ...updateData,
                displayOrder: updateData.displayOrder || 0,  // Ensure displayOrder is set
                 targetUrl: updateData.targetUrl?.trim() || ''
            },
            { new: true }
        )

        if (!updatedBanner) {
            throw new Error("Banner not found")
        }

        res.json({
            message: "Banner Updated Successfully",
            success: true,
            error: false,
            data: updatedBanner
        })
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        })
    }
}

module.exports = updateBannerController