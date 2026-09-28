const uploadProductPermission = require("../../helpers/permission");
const productModel = require("../../models/productModel");

async function getHiddenProductsController(req, res) {
    try {
        if (!(await uploadProductPermission(req.userId))) {
            throw new Error("Permission denied");
        }

        const hiddenProducts = await productModel.find({ isHidden: true }).sort({ createdAt: -1 });

        res.json({
            message: "Hidden Products",
            success: true,
            error: false,
            data: hiddenProducts,
        });
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false,
        });
    }
}

module.exports = getHiddenProductsController;
