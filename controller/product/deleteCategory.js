const uploadProductPermission = require("../../helpers/permission")
const categoryModel = require("../../models/categoryModel");

async function DeleteCategoryController(req, res) {
    try {
        const sessionUserId = req.userId;
        
        // Check permission
        if (!(await uploadProductPermission(sessionUserId))) {
            throw new Error("Permission denied");
        }

        const { _id } = req.body;

        // Validate category id
        if (!_id) {
            throw new Error("Category ID is required");
        }

        // Find and delete the category
        const deletedCategory = await categoryModel.findByIdAndDelete(_id);

        if (!deletedCategory) {
            throw new Error("Category not found");
        }

        res.status(200).json({
            message: "Category Deleted Successfully",
            error: false,
            success: true,
            data: deletedCategory
        });

    } catch (err) {
        res.status(400).json({
            message: err.message || "Error deleting category",
            error: true,
            success: false
        });
    }
}

module.exports = DeleteCategoryController;