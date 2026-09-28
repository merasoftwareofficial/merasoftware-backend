const uploadProductPermission = require("../../helpers/permission")
const categoryModel = require("../../models/categoryModel");

async function UploadCategoryController(req, res) {
    try {
        const sessionUserId = req.userId;
        if (!(await uploadProductPermission(sessionUserId))) {
            throw new Error("Permission denied");
        }
        
        // Validate required fields
        const { categoryName, categoryValue, imageUrl } = req.body;
        if (!categoryName || !categoryValue || !imageUrl) {
            throw new Error("Missing required fields");
        }

        const category = new categoryModel(req.body);
        const savedCategory = await category.save();

        res.status(201).json({
            message: "Category Added Successfully",
            error: false,
            success: true,
            data: savedCategory
        });
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error: true,
            success: false
        });
    }
}

module.exports = UploadCategoryController;