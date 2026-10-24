const userModel = require("../../models/userModel")

async function userDetailsController (req,res) {
    try {
        console.log("userId", req.userId);
         const user = await userModel.findById(req.userId).select('name email roles profilePic phone age walletBalance userDetails bankAccounts isGuest allowLoginFreeUploadLinks');

        if (!user) {
            throw new Error("User not found");
        }

        // A reservation lead is explicitly upgraded in place by an admin. Refresh
        // only that obsolete member session; ordinary multi-role choices stay intact.
        let activeRole = req.userRole;
        if (activeRole === 'member' && user.roles.length === 1 && user.roles[0] === 'customer') {
            activeRole = 'customer';
            require('../../helpers/sessionToken').issueSession(res, { _id: user._id, email: user.email, role: activeRole });
        }

        res.status(200).json({
            data: {
                ...user._doc,
                role: activeRole,
                walletBalance: user.walletBalance, // Explicitly include wallet balance
                bankAccounts: user.bankAccounts,
                userDetails: {
                    ...user.userDetails,
                    isDetailsCompleted: user.userDetails?.isDetailsCompleted || false
                }
            },
            error : false,
            success: true,
            message: "User Details"
        })

        console.log("user", user);
    } catch (err) {
        res.status(400).json({
            message: err.message || err,
            error : true,
            success : false
        })
    }
}

module.exports = userDetailsController
