const userModel = require("../../models/userModel")
const bcrypt = require('bcryptjs');
const { STORE_PLAIN_PASSWORD } = require('../../config/accessControlConfig');


async function userSignUpController (req,res) {
    try {
        const { email, password, name, referredBy } = req.body

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            throw new Error("Please provide valid email address");
        }

        if(!email){
            throw new Error("Please provide email")
        }
        if(!password){
            throw new Error("Please provide password")
        }
        if(!name){
            throw new Error("Please provide name")
        }
        // Public sign-up (the website's "Create account") makes a blog-only 'member':
        // no portal screens, not a client. The caller never chooses the role — portal
        // roles (customer, admin, ...) are granted by an admin through /api/addRole.
        const userRole = 'member';

        // Password validation
        if (password.length < 6) {
            throw new Error("Password must be at least 6 characters long");
        }

        const salt = bcrypt.genSaltSync(10);
        const hashPassword = await bcrypt.hashSync(password, salt);

        if(!hashPassword){
            throw new Error("Something is Wrong")
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Check if user with email exists
        let existingUser = await userModel.findOne({ email: normalizedEmail });

        if (existingUser) {
            // Sign up never grants a role to an existing account — that was the
            // other half of the same hole (email already registered + a role in
            // the body used to add it with no password check). An account that
            // already exists should sign in instead.
            throw new Error("An account with this email already exists. Please sign in.");
        }

        // If user does not exist, create new user with roles array (blog-only member)
        const payload = {
            email: normalizedEmail,
            name,
            password: hashPassword,
            roles: [userRole],
            walletBalance: 0,
            referredBy: referredBy ? referredBy : null, // Store the referrer ID
            referrals: [] // Initialize an empty array for tracking referrals
        }

        // Store plaintext copy for admin viewing (gated by config flag).
        if (STORE_PLAIN_PASSWORD) {
            payload.plainPassword = password;
        }

        const userData = new userModel(payload)
        const saveUser = await userData.save()

        // If a referrer is provided, update their document
         if (referredBy) {
            const referrer = await userModel.findById(referredBy);

            // Add new referral object with userId, role, and referredDate
            await userModel.findByIdAndUpdate(referredBy, {
                $addToSet: { referrals: { userId: saveUser._id, role: userRole, referredDate: new Date() } }
            });
        }

        res.status(201).json({
            data: { ...saveUser.toObject(), password: undefined, plainPassword: undefined },
            success: true,
            error: false,
            message: "User Created Successfully!"
        })

    } catch (err) {
        res.json({
            message: err.message || err,
            error: true,
            success: false,
        })  
    }
}


module.exports = userSignUpController