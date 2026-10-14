const { clearSession } = require('../../helpers/sessionToken');
async function userLogout (req,res){
    try {
        clearSession(res);

        res.json({
            message: "Logged out successfully",
            error: false,
            success: true,
            data: []
        })

    } catch (err) {
        res.json({
            message: err.message || err,
            error: true,
            success: false,
        })
    }
}

module.exports = userLogout
