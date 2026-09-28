const jwt = require('jsonwebtoken')
const userModel = require('../models/userModel')

async function authToken(req, res, next) {
    try {
        const token = req.cookies?.token

        if (!token) {
            return res.status(401).json({
                message: "Please Login...!",
                error: true,
                success: false
            })
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.TOKEN_SECRET_KEY);
        } catch (err) {
            return res.status(401).json({
                message: "Invalid token. Please login again.",
                error: true,
                success: false
            });
        }

        req.userId = decoded?._id;
        req.userRole = decoded?.role;

        if (!req.userId) {
            return res.status(401).json({
                message: "User ID not found in token. Please login again.",
                error: true,
                success: false
            });
        }

        // Tokens live 365 days, so a ban or deletion must be checked here, not only at sign-in.
        const user = await userModel.findById(req.userId).select('isActive isGuest').lean();

        if (!user) {
            return res.status(401).json({
                message: "Account not found. Please login again.",
                error: true,
                success: false
            });
        }

        if (user.isActive === false) {
            return res.status(401).json({
                message: "Your account has been disabled. Please contact support.",
                error: true,
                success: false
            });
        }

        // Guest inactivity clock: only guests carry lastActivityAt.
        if (user.isGuest) {
            userModel.updateOne(
                { _id: req.userId },
                { $set: { lastActivityAt: new Date() } }
            ).catch((updateErr) => {
                console.error("Failed to refresh guest lastActivityAt:", updateErr.message);
            });
        }

        next();

    } catch (err) {
        console.error("Unexpected error in auth middleware:", err);
        res.status(500).json({
            message: "Authentication error occurred",
            data: [],
            error: true,
            success: false
        });
    }
}

module.exports = authToken;
