const uploadProductPermission = require("../../helpers/permission");
const { setProductHidden } = require("../../helpers/servicePlanLifecycle");

// Rules (retired plans and, until the new builder is live, flexible plans cannot be put on
// sale here): helpers/servicePlanLifecycle.js.
async function unhideProductController(req, res) {
    try {
        if (!(await uploadProductPermission(req.userId))) {
            throw new Error("Permission denied");
        }
        const updatedProduct = await setProductHidden({ productId: req.body?._id, hidden: false });
        res.json({
            message: "Product unhidden successfully",
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

module.exports = unhideProductController;
