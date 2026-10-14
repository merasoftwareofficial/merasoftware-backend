const userModel = require("../../models/userModel");
const { issueSession } = require('../../helpers/sessionToken');
const { verifyOTP } = require('../../helpers/otpUtils');

async function verifyOtpController(req, res) {
    try {
        const { userId, otp, role } = req.body;
        
        if (!userId || !otp || !role) {
            throw new Error("User ID and OTP are required");
        }
        
        // Verify OTP
        const isValid = await verifyOTP(userId, otp);
        
        if (!isValid) {
            throw new Error("Invalid or expired OTP. Please try again.");
        }
        
        // Mark user as OTP verified
        await userModel.findByIdAndUpdate(userId, { isOtpVerified: true });
        
        // Generate token
        const user = await userModel.findById(userId).select('email name roles walletBalance userDetails');
        
        // ✅ Make sure requested role is in user's allowed roles
        if (!user.roles.includes(role.toLowerCase())) {
            throw new Error("User does not have the selected role");
        }

        const tokenData = {
            _id: user._id,
            email: user.email,
            role: role.toLowerCase()
        };
        
        const token = issueSession(res, tokenData);

        res.status(200).json({
            message: "OTP verified successfully",
            data: {
                token,
                user: {
                    ...user._doc,
                    role: role.toLowerCase() 
                },
                walletBalance: user.walletBalance,
                 // ✅ Add isDetailsCompleted from database
                isDetailsCompleted: user.userDetails?.isDetailsCompleted || false,
            },
            success: true,
            error: false
        });
    } catch (err) {
        res.json({
            message: err.message || err,
            error: true,
            success: false,
        });
    }
}

module.exports = verifyOtpController;