const { createAccount, publicAccount } = require('../../helpers/accountCreation');
const { linkPersonLead } = require('../../helpers/personLead');


async function userSignUpController (req,res) {
    try {
        // Public sign-up (the website's "Create account") makes a blog-only 'member':
        // no portal screens, not a client. The caller never chooses the role — portal
        // accounts are made by an admin through /api/admin/create-account.
        const saveUser = await createAccount(req.body || {}, 'member')

        // The person's one lead (merasoftware/src/docs/signup.md §3.6). The account is saved
        // whatever happens here: a miss is logged, and the person-lead backfill can fix it later.
        await linkPersonLead(saveUser).catch((error) => console.error('Signup: could not link the lead for', saveUser.email, '-', error.message))

        res.status(201).json({
            data: publicAccount(saveUser),
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
