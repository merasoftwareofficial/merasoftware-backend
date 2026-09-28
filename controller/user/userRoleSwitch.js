const jwt = require('jsonwebtoken');
const userModel = require('../../models/userModel');

async function userRoleSwitchController(req, res) {
  try {
    const userId = req.userId;
    const { newRole } = req.body;

    if (!newRole) {
      return res.status(400).json({
        message: "New role is required",
        success: false,
        error: true,
      });
    }

    // Find user by ID
    const user = await userModel.findById(userId).select('email name roles userDetails bankAccounts'); // Add userDetails here

    if (!user) {
      return res.status(404).json({
        message: "User not found",
        success: false,
        error: true,
      });
    }

    // Check if newRole is in user's roles array
    if (!user.roles.includes(newRole.toLowerCase())) {
      return res.status(403).json({
        message: "User does not have the requested role",
        success: false,
        error: true,
      });
    }

    // Generate new token with new role
    const tokenData = {
      _id: user._id,
      email: user.email,
      role: newRole.toLowerCase(),
    };

    const token = jwt.sign(tokenData, process.env.TOKEN_SECRET_KEY, { expiresIn: '365d' });

    const tokenOption = {
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    };

    // Same cookie shape as userSignIn/userLogout, so logout clears this exact cookie.
    if (process.env.COOKIE_DOMAIN) {
      tokenOption.domain = process.env.COOKIE_DOMAIN;
    }

    // Set new token cookie
    res.cookie("token", token, tokenOption);

    res.status(200).json({
      message: "Role switched successfully",
      success: true,
      error: false,
      data: {
        token,
        role: newRole.toLowerCase(),
        isDetailsCompleted: user.userDetails?.isDetailsCompleted || false,
        bankAccounts: user.bankAccounts
      },
    });
  } catch (err) {
    console.error("Error in userRoleSwitchController:", err);
    res.status(500).json({
      message: "Internal server error",
      success: false,
      error: true,
    });
  }
}

module.exports = userRoleSwitchController;
