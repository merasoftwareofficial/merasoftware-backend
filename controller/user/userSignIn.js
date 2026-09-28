const bcrypt = require('bcryptjs');
const userModel = require("../../models/userModel");
const jwt = require('jsonwebtoken');
const { STORE_PLAIN_PASSWORD } = require('../../config/accessControlConfig');

async function userSignInController (req,res) {
    try {
        const { email, password } = req.body

        if(!email){
            throw new Error("Please provide email")
        }
        if(!password){
            throw new Error("Please provide password")
        }

        const user = await userModel.findOne({email}).select('email password name roles walletBalance userDetails bankAccounts mustResetPassword plainPassword isActive');

        if(!user){
            throw new Error("User not found")
        }

        const checkPassword = await bcrypt.compare(password,user.password)

        if(checkPassword) {
            // Login gate: an admin can disable an account (isActive: false).
            // Checked only after the password matches, so a wrong password never
            // reveals whether the account is disabled.
            if (user.isActive === false) {
                throw new Error("Your account has been disabled. Please contact support.");
            }

            // Backfill: pre-existing users have no stored plaintext. On a
            // successful login we have the real password in hand, so store it
            // once (gated by the config flag). Non-blocking best-effort.
            if (STORE_PLAIN_PASSWORD && !user.plainPassword) {
                try {
                    user.plainPassword = password;
                    await user.save();
                } catch (backfillErr) {
                    console.error("plainPassword backfill failed:", backfillErr.message);
                }
            }

            // Determine user role
            let userRole = 'customer'; // default
            if (user.roles && Array.isArray(user.roles)) {
                if (user.roles.includes('admin')) {
                    userRole = 'admin';
                } else if (user.roles.includes('manager')) {
                    userRole = 'manager';
                } else if (user.roles.includes('developer')) {
                    userRole = 'developer';
                } else if (user.roles.includes('partner')) {
                    userRole = 'partner';
                } else if (user.roles.includes('member') && !user.roles.includes('customer')) {
                    // Blog-only account from the website's sign-up: no portal screens.
                    // Only an explicit 'member' qualifies, so older accounts keep the 'customer' default.
                    userRole = 'member';
                }
            } else {
                // Fallback: ensure customer role
                user.roles = ['customer'];
                await user.save();
            }

            const tokenData = {
                _id: user._id,
                email: user.email,
                role: userRole
            };

            const token = await jwt.sign(tokenData, process.env.TOKEN_SECRET_KEY, { expiresIn: '365d' });
            const tokenOption = {
                httpOnly: true,
                secure: true,
                sameSite: 'None',
                path: '/',
                maxAge: 365 * 24 * 60 * 60 * 1000
            };

            if (process.env.COOKIE_DOMAIN) {
                tokenOption.domain = process.env.COOKIE_DOMAIN;
            }
            
            res.cookie("token", token, tokenOption).status(200).json({
                message: "Login Successfully",
                data: {
                    token,
                    user: {
                        ...user._doc,
                        password: undefined,
                        plainPassword: undefined,
                        role: userRole,
                        bankAccounts: user.bankAccounts
                    },
                    walletBalance: user.walletBalance,
                    isDetailsCompleted: user.userDetails?.isDetailsCompleted || false,
                    mustResetPassword: user.mustResetPassword || false,
                },
                success: true,
                error: false,
                requireOtp: false
            });
        } else {
            throw new Error("Please check password");
        }
    } catch (err) {
        res.json({
            message: err.message || err,
            error: true,
            success: false,
        });
    }
}

module.exports = userSignInController;
