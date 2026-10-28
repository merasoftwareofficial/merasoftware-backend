const productModel = require("../../models/productModel")
const { priceRange } = require("../../helpers/servicePlanPricing")

// Service plan cards show the plan's own range (one update at min … max files); the portal never
// works it out (merasoftware/src/docs/plan.md §4 "Price"). null when the plan cannot be priced.
const withPriceRange = (product) => {
    const row = product.toJSON()
    if (row.isServicePlan) {
        try { row.priceRange = priceRange(row) } catch { row.priceRange = null }
    }
    return row
}

const getProductController = async (req,res)=>{
    try {
        
        // retiredAt: a retired plan is withdrawn for good and must never be sellable
        // again, even if something later flips isHidden back.
        const allProduct = await productModel.find({ isHidden: false, retiredAt: null, archivedAt: null }).sort({ createdAt : -1 })

        res.json({
            message : "All Product",
            success : true,
            error : false,
            data : allProduct.map(withPriceRange)
        })
    } catch (err) {
        res.status(400).json({
            message : err.message || err,
            error : true,
            success : false
        })
    }
}

module.exports = getProductController
