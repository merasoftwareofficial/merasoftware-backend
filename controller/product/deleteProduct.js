const uploadProductPermission = require("../../helpers/permission")
const productModel = require("../../models/productModel")
const orderModel = require("../../models/orderProductModel")

async function deleteProductController(req, res) {
    try {
        // Check permission
        if (!(await uploadProductPermission(req.userId))) {
            throw new Error("Permission denied")
        }

        // Get product ID from request
        const { _id } = req.body

        // A product that customers have already bought must never be hard-deleted:
        // its orders and paid invoices are the business record behind it. Retire it
        // instead (controller/product/retireOrDeletePlan.js), which withdraws it for
        // good while keeping the row. This guard is enforced here, not only in the
        // UI, because this route is reachable directly.
        const purchaseCount = await orderModel.countDocuments({ productId: _id })
        if (purchaseCount > 0) {
            throw new Error(
                `This product has ${purchaseCount} purchase${purchaseCount === 1 ? "" : "s"} and cannot be deleted. Retire it instead to keep the customer's history intact.`
            )
        }

        // Delete product from database
        const deletedProduct = await productModel.findByIdAndDelete(_id)

        // If product not found
        if (!deletedProduct) {
            throw new Error("Product not found")
        }

        // Send success response
        res.json({
            message: "Product Deleted Successfully",
            success: true,
            error: false,
            data: deletedProduct
        })

    } catch (err) {
        // Error handling
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        })
    }
}

module.exports = deleteProductController