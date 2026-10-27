const uploadProductPermission = require("../../helpers/permission")
const productModel = require("../../models/productModel")
const orderModel = require("../../models/orderProductModel")


async function updateProductController (req,res){
    try {

        if(!(await uploadProductPermission(req.userId))){
            throw new Error("Permission denied")
        }

        const { _id, ...resBody } = req.body

        // Service plans are saved only through helpers/servicePlanCatalogue.js (validated, never a
        // spread body). This generic route stays for feature products.
        const target = await productModel.findById(_id).select('isServicePlan category').lean()
        if (target && (target.isServicePlan || target.category === 'service_plan')) {
            throw new Error("Service plans are edited from the plan settings, not here")
        }

        // Allow updating isHidden field if present
        const updateData = { ...resBody }
        if (typeof resBody.isHidden !== 'undefined') {
            updateData.isHidden = resBody.isHidden
        }

        const updateProduct = await productModel.findByIdAndUpdate(_id, updateData, { new: true })

        if (!updateProduct) {
            throw new Error("Product not found")
        }

        if (updateProduct.isMonthlyLimitedPlan) {
            const monthlyLimit = Number(updateProduct.monthlyUpdateLimit) || 1

            await orderModel.updateMany(
                {
                    productId: updateProduct._id,
                    isActive: true
                },
                [
                    {
                        $set: {
                            currentMonthUpdatesLimit: monthlyLimit,
                            currentMonthUpdatesRemaining: {
                                $max: [
                                    0,
                                    {
                                        $subtract: [
                                            monthlyLimit,
                                            { $ifNull: ["$currentMonthUpdatesUsed", 0] }
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                ]
            )
        }

        res.json({
            message : "Product Updated Successfully",
            success : true,
            error : false,
            data : updateProduct
        })
        
    } catch (err) {
        res.status(400).json({
            message : err.message || err,
            error : true,
            success : false
        })
    }
}

module.exports = updateProductController
