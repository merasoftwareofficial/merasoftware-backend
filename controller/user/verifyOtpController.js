const userModel = require("../../models/userModel");
const jwt = require('jsonwebtoken');
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
        
        const token = await jwt.sign(tokenData, process.env.TOKEN_SECRET_KEY, { expiresIn: '365d' });
        const tokenOption = {
            httpOnly: true,
            secure: true,
            sameSite: 'None',
            path: '/',
            maxAge: 365 * 24 * 60 * 60 * 1000
        };

        // Same cookie shape as userSignIn/userLogout, so logout clears this exact cookie.
        if (process.env.COOKIE_DOMAIN) {
            tokenOption.domain = process.env.COOKIE_DOMAIN;
        }

        res.cookie("token", token, tokenOption).status(200).json({
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