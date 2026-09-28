const uploadAdPermission = require("../../helpers/permission")
const adModel = require("../../models/adModel")

async function UploadAdController(req,res){
    try {
        const sessionUserId = req.userId
        
        // Permission check for admin
        if(!(await uploadAdPermission(sessionUserId))){
            throw new Error("Permission denied")
        }

        // Create and save new ad
        const uploadAd = new adModel(req.body)
        const saveAd = await uploadAd.save()

        res.status(201).json({
            message : "Ad Uploaded Successfully",
            error : false,
            success : true,
            data : saveAd
        })
    } catch (err) {
        res.status(400).json({
            message : err.message || err,
            error : true,
            success : false
        })
    }
}

module.exports = UploadAdController