const uploadProductPermission = require("../../helpers/permission")
const productModel = require("../../models/productModel")

async function UploadProductController(req,res){
    try {
        const sessionUserId = req.userId

        if(!(await uploadProductPermission(sessionUserId))){
            throw new Error("Permission denied")
        }

        // Allow setting isHidden field if present
        const productData = { ...req.body }
        if (typeof req.body.isHidden !== 'undefined') {
            productData.isHidden = req.body.isHidden
        }

        // Special handling for yearly renewable plans
        if (productData.isMonthlyRenewablePlan) {
            // Validate required fields for yearly plans
            if (!productData.yearlyPlanDuration || !productData.monthlyRenewalCost) {
                throw new Error("Yearly plan duration and monthly renewal cost are required for renewable plans")
            }

            // Ensure proper values for yearly plans
            productData.validityPeriod = 30; // Current active period
            productData.updateCount = 999999; // Unlimited updates
            productData.isUnlimitedUpdates = true;
            productData.isWebsiteUpdate = true; // Ensure it's marked as website update

            console.log('Creating yearly renewable plan:', {
                yearlyPlanDuration: productData.yearlyPlanDuration,
                monthlyRenewalCost: productData.monthlyRenewalCost,
                isMonthlyRenewablePlan: productData.isMonthlyRenewablePlan
            });
        }

        const uploadProduct = new productModel(productData)
        const saveProduct = await uploadProduct.save()

        res.status(201).json({
            message : "Product Uploaded Successfully",
            error : false,
            success : true,
            data : saveProduct
        })
    } catch (err) {
        res.status(400).json({
            message : err.message || err,
            error : true,
            success : false
        })
    }
}

module.exports = UploadProductController