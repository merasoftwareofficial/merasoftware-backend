const uploadProductPermission = require("../../helpers/permission");
const { setProductHidden } = require("../../helpers/servicePlanLifecycle");

// Rules (a retired plan's isHidden belongs to retire/restore): helpers/servicePlanLifecycle.js.
async function hideProductController(req, res) {
    try {
        if (!(await uploadProductPermission(req.userId))) {
            throw new Error("Permission denied");
        }
        const updatedProduct = await setProductHidden({ productId: req.body?._id, hidden: true });
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
