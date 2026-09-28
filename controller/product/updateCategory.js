const uploadProductPermission = require("../../helpers/permission")
const categoryModel = require("../../models/categoryModel")

async function updateCategoryController(req, res) {
    try {
        // Check permission
        if (!(await uploadProductPermission(req.userId))) {
            throw new Error("Permission denied")
        }

        // Extract _id and rest of the body
        const { _id, ...resBody } = req.body

        // Update category
        const updatedCategory = await categoryModel.findByIdAndUpdate(
            _id,
            resBody,
            { new: true } // यह option updated document return करेगा
        )

        if (!updatedCategory) {
            throw new Error("Category not found")
        }

        res.json({
            message: "Category Updated Successfully",
            success: true,
            error: false,
            data: updatedCategory
        })

    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        })
    }
}

module.exports = updateCategoryController