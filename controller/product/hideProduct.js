const uploadProductPermission = require("../../helpers/permission");
const productModel = require("../../models/productModel");

async function hideProductController(req, res) {
    try {
        if (!(await uploadProductPermission(req.userId))) {
            throw new Error("Permission denied");
        }

        const { _id } = req.body;
        if (!_id) {
            throw new Error("Product ID is required");
        }

        // Plans have no manual availability switch: Remove disables a plan into the
        // Retired tab and Restore enables it back into Active. So a retired plan's
        // isHidden is owned by that lifecycle and must not be flipped from outside it
        // — doing so would leave the plan disabled-but-Active or live-but-Retired.
        // Enforced here as well as in the UI because this route is reachable directly.
        const existing = await productModel.findById(_id).select("retiredAt archivedAt");
        if (!existing) {
            throw new Error("Product not found");
        }
        if (existing.retiredAt || existing.archivedAt) {
            throw new Error("This plan is retired. Restore it before changing its availability.");
        }

        const updatedProduct = await productModel.findByIdAndUpdate(
            _id,
            { isHidden: true },
            { new: true }
        );

        if (!updatedProduct) {
            throw new Error("Product not found");
        }

        res.json({
            message: "Product hidden successfully",
            success: true,
            error: false,
            data: updatedProduct,
        });
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false,
        });
    }
}

module.exports = hideProductController;
